import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { errorPayload } from "./lib/errors.js";
import { getWriteAuthorizerState } from "./lib/config.js";
import {
  assertPermissionMode,
  authorizeWorkspaceWrite,
  validateTaskText
} from "./lib/policy.js";
import { validateWorkspace } from "./lib/path-policy.js";
import { getWriteGrantStatus } from "./lib/write-grant.js";
import { safeJsonStringify, redactSecrets } from "./lib/text.js";

const SURFACE_NOTE =
  "Local MCP tools are exposed to the host only. Current ChatGPT desktop builds may install a local plugin but not expose its tools in ordinary Chat; Work (local) or Codex are the supported local execution surfaces. Treat the integration as successful only after a real tool call returns.";

const MODE_DESCRIPTION =
  "read-only (default; cannot write) or workspace-write (requires allow_write=true plus a valid local write grant for this exact workspace). The write grant is created locally; no token is sent to the model. danger-full-access is intentionally unavailable.";

const taskStatusSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  terminal: z.boolean(),
  workspace: z.string(),
  permission_mode: z.string(),
  created_at: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  elapsed_ms: z.number(),
  timeout_seconds: z.number(),
  exit_code: z.number().nullable(),
  dsh_session_id: z.string().nullable(),
  progress: z.object({
    phase: z.string(),
    turn: z.number().nullable(),
    step: z.number().nullable(),
    event_count: z.number(),
    last_event_type: z.string().nullable()
  }),
  cancel_requested: z.boolean(),
  error: z
    .object({
      code: z.string(),
      message: z.string()
    })
    .nullable()
});

const nextSchema = z.object({
  tool: z.string(),
  task_id: z.string(),
  wait_seconds: z.number().optional()
});

const healthOutput = z.object({
  ok: z.boolean(),
  bridge: z.object({
    name: z.string(),
    version: z.string()
  }),
  checked_at: z.string(),
  dsh: z.object({
    found: z.boolean(),
    cli_path: z.string().nullable(),
    version: z.string().nullable(),
    profile: z.string(),
    dsh_home: z.string(),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    credentials_present: z.boolean(),
    config_exit_code: z.number().nullable()
  }),
  model_probe: z.object({
    checked: z.boolean(),
    ok: z.boolean().nullable(),
    latency_ms: z.number().nullable(),
    response_excerpt: z.string().nullable(),
    error: z.string().nullable()
  }),
  security: z.object({
    write_mode_enabled: z.boolean(),
    write_ready: z.boolean(),
    write_authorization: z.string(),
    write_authorizer_key_present: z.boolean(),
    write_grant: z.object({
      present: z.boolean(),
      valid: z.boolean(),
      expired: z.boolean(),
      kind: z.string().nullable(),
      permanent: z.boolean(),
      reason: z.string(),
      grant_id: z.string().nullable(),
      workspace: z.string().nullable(),
      expires_at: z.string().nullable()
    }),
    allowed_roots_count: z.number(),
    allowed_roots: z.array(z.string())
  }),
  warnings: z.array(z.string()),
  surface_note: z.string()
});

const startOutput = z.object({
  ok: z.boolean(),
  task: taskStatusSchema,
  terminal: z.boolean(),
  message: z.string().optional(),
  next: nextSchema.optional()
});

const statusOutput = z.object({
  ok: z.boolean(),
  task: taskStatusSchema,
  terminal: z.boolean(),
  message: z.string().optional(),
  next: nextSchema.optional()
});

const resultOutput = z.object({
  ok: z.boolean(),
  task_id: z.string(),
  status: z.string(),
  terminal: z.boolean(),
  result: z
    .object({
      text: z.string(),
      truncated: z.boolean(),
      tests: z.array(z.string()),
      errors: z.array(z.object({ code: z.string(), message: z.string() })),
      usage: z.record(z.string(), z.unknown()).nullable(),
      exit_code: z.number().nullable(),
      duration_ms: z.number(),
      dsh_session_id: z.string().nullable(),
      log_excerpt: z.string().optional(),
      logs_truncated: z.boolean().optional()
    })
    .nullable(),
  message: z.string().optional(),
  next: nextSchema.optional()
});

const cancelOutput = z.object({
  ok: z.boolean(),
  task_id: z.string(),
  cancelled: z.boolean(),
  already_terminal: z.boolean().optional(),
  status: z.string(),
  message: z.string()
});

const listOutput = z.object({
  ok: z.boolean(),
  count: z.number(),
  active_count: z.number(),
  max_tasks: z.number(),
  max_concurrent_tasks: z.number(),
  tasks: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      status: z.string(),
      terminal: z.boolean(),
      permission_mode: z.string(),
      workspace: z.string(),
      created_at: z.string(),
      elapsed_ms: z.number()
    })
  )
});

function textResult(payload, maxChars = 12_000) {
  return {
    content: [
      {
        type: "text",
        text: safeJsonStringify(payload, maxChars)
      }
    ],
    structuredContent: payload
  };
}

function failureResult(error) {
  const payload = errorPayload(error, "TOOL_FAILED");
  const text = `${payload.error.code}: ${payload.error.message}`;
  // Do not attach structuredContent to an error result: MCP clients may still
  // validate it against the tool's success output schema and mask the real
  // error with a schema-validation failure.
  return {
    isError: true,
    content: [{ type: "text", text: redactSecrets(text).slice(0, 4_000) }]
  };
}

function guarded(logger, name, handler) {
  return async (args, extra) => {
    try {
      return await handler(args, extra);
    } catch (error) {
      logger.warn("tool_error", {
        tool: name,
        code: error?.code || "TOOL_FAILED",
        message: redactSecrets(error?.message || "unknown error").slice(0, 500)
      });
      return failureResult(error);
    }
  };
}

export function registerBridgeTools(server, { config, runner, tasks, logger }) {
  server.registerTool(
    "dsh_health_check",
    {
      title: "Check DSH bridge health",
      description:
        "Check the local DSH CLI, headless profile, DeepSeek account route, local write authorization, and credential-file presence without reading credentials. Set probe=true to make a tiny live DSH model call and verify the model connection. Does not modify files.",
      inputSchema: {
        probe: z
          .boolean()
          .optional()
          .default(false)
          .describe("When true, run a small real DSH model call (uses a small amount of DeepSeek usage).")
      },
      outputSchema: healthOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    guarded(logger, "dsh_health_check", async ({ probe }) => {
      const authorizer = getWriteAuthorizerState(config.security);
      const warnings = config.warnings.filter((warning) => !warning.includes("authorizer key is missing"));
      if (config.security.writeModeEnabled && !authorizer.writeReady) {
        warnings.push("Local authorizer key missing. Issue a local grant with scripts\\approve-write.ps1.");
      }
      const checkedAt = new Date().toISOString();
      let writeGrant;
      try {
        writeGrant = config.security.writeModeEnabled
          ? await getWriteGrantStatus(config)
          : {
              present: false,
              valid: false,
              expired: false,
              kind: null,
              permanent: false,
              reason: "write-mode-disabled",
              grant_id: null,
              workspace: null,
              expires_at: null
            };
      } catch {
        writeGrant = {
          present: false,
          valid: false,
          expired: false,
          kind: null,
          permanent: false,
          reason: "grant-read-failed",
          grant_id: null,
          workspace: null,
          expires_at: null
        };
      }
      if (config.security.writeModeEnabled && !writeGrant.valid) {
        warnings.push(
          "Write mode is enabled but no valid local write grant is active. Run scripts\\approve-write.ps1 for the target workspace."
        );
      }
      const base = {
        ok: false,
        bridge: { name: config.bridge.name, version: config.bridge.version },
        checked_at: checkedAt,
        dsh: {
          found: false,
          cli_path: null,
          version: null,
          profile: config.dsh.profile,
          dsh_home: config.dsh.dshHome,
          provider: null,
          model: null,
          credentials_present: existsSync(path.join(config.dsh.dshHome, ".credentials.yaml")),
          config_exit_code: null
        },
        model_probe: {
          checked: false,
          ok: null,
          latency_ms: null,
          response_excerpt: null,
          error: null
        },
        security: {
          write_mode_enabled: config.security.writeModeEnabled,
          write_ready: authorizer.writeReady,
          write_authorization: config.security.writeAuthorization,
          write_authorizer_key_present: authorizer.writeAuthorizerKeyPresent,
          write_grant: {
            present: writeGrant.present,
            valid: writeGrant.valid,
            expired: writeGrant.expired,
            kind: writeGrant.kind,
            permanent: writeGrant.permanent === true,
            reason: writeGrant.reason,
            grant_id: writeGrant.grant_id,
            workspace: writeGrant.workspace,
            expires_at: writeGrant.expires_at
          },
          allowed_roots_count: config.security.allowedRoots.length,
          allowed_roots: config.security.allowedRoots
        },
        warnings,
        surface_note: SURFACE_NOTE
      };

      try {
        const launchSpec = runner.getLaunchSpec();
        base.dsh.cli_path = launchSpec.cliPath;
        const version = await runner.getVersion();
        base.dsh.version = version.version;
        base.dsh.found = true;
      } catch (error) {
        warnings.push(error.message);
        return textResult(base);
      }

      try {
        const dump = await runner.dumpConfigSummary();
        base.dsh.config_exit_code = dump.exitCode;
        base.dsh.provider = dump.provider;
        base.dsh.model = dump.model;
        if (dump.exitCode !== 0) warnings.push("DSH --dump-config did not exit successfully.");
        if (!dump.hasHeadless) warnings.push("The headless bundle was not found in the composed profile.");
        if (!dump.hasDeepseekAccount && dump.provider !== "deepseek-account") {
          warnings.push("The deepseek-account provider route was not detected in the headless profile.");
        }
      } catch (error) {
        warnings.push(`Profile check failed: ${error.message}`);
      }

      if (probe) {
        base.model_probe.checked = true;
        try {
          const probeResult = await runner.probeModel();
          base.model_probe = {
            checked: true,
            ok: probeResult.ok,
            latency_ms: probeResult.latency_ms,
            response_excerpt: probeResult.response_excerpt,
            error: probeResult.error
          };
          if (!probeResult.ok) warnings.push("The live DSH model probe did not return DSH_BRIDGE_OK.");
        } catch (error) {
          base.model_probe = {
            checked: true,
            ok: false,
            latency_ms: null,
            response_excerpt: null,
            error: redactSecrets(error.message).slice(0, 500)
          };
          warnings.push("The live DSH model probe failed.");
        }
      }

      base.ok =
        base.dsh.found &&
        base.dsh.config_exit_code === 0 &&
        (probe ? base.model_probe.ok === true : true);
      return textResult(base);
    })
  );

  server.registerTool(
    "dsh_start_task",
    {
      title: "Start a DSH coding task",
      description:
        `Start an asynchronous headless DSH task in an absolute workspace. Permission mode: ${MODE_DESCRIPTION} ` +
        "The default is read-only. Use this only when local work is actually needed, not for ordinary conversation. " +
        "Poll with dsh_get_status/dsh_get_result using wait_seconds instead of tight loops.",
      inputSchema: {
        task: z
          .string()
          .min(1)
          .max(config.limits.maxTaskChars)
          .describe("The concrete task for DSH. Include scope, acceptance checks, and constraints."),
        workspace: z
          .string()
          .min(1)
          .describe("Absolute path to the project directory. DSH runs with this as its cwd."),
        permission_mode: z
          .enum(["read-only", "workspace-write"])
          .optional()
          .default("read-only")
          .describe("read-only is the default. workspace-write requires allow_write=true plus a valid local write grant for this workspace."),
        title: z.string().max(120).optional().describe("Short human-readable label for the task."),
        timeout_seconds: z
          .number()
          .int()
          .min(30)
          .max(config.limits.maxTimeoutSeconds)
          .optional()
          .describe("Maximum runtime in seconds. Bounded by the bridge config."),
        allow_write: z
          .boolean()
          .optional()
          .default(false)
          .describe("Set true only when the user requested file modifications. A local write grant is still required; no token is accepted or needed.")
      },
      outputSchema: startOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    guarded(logger, "dsh_start_task", async (args) => {
      assertPermissionMode(args.permission_mode);
      const taskText = validateTaskText(args.task, config.limits.maxTaskChars);
      const workspace = await validateWorkspace(args.workspace, config);
      const authorization = await authorizeWorkspaceWrite(config, {
        permissionMode: args.permission_mode,
        allowWrite: args.allow_write,
        workspace
      });

      const timeoutSeconds = Math.min(
        config.limits.maxTimeoutSeconds,
        Math.max(30, args.timeout_seconds ?? config.limits.defaultTimeoutSeconds)
      );

      const status = await tasks.start({
        task: taskText,
        title: args.title,
        workspace,
        permissionMode: args.permission_mode,
        timeoutSeconds
      });
      if (authorization.required) {
        status.message = authorization.permanent
          ? `Task started with permanent local write grant ${authorization.grant_id} for ${authorization.workspace}. No token was sent to the model.`
          : `Task started with local write grant ${authorization.grant_id}, expiring ${authorization.expires_at}. No token was sent to the model.`;
      }
      return textResult(status);
    })
  );

  server.registerTool(
    "dsh_get_status",
    {
      title: "Get DSH task status",
      description:
        "Return the bounded status of a DSH task. Set wait_seconds for a short long-poll (maximum 25s) instead of polling rapidly. " +
        "When terminal is true, call dsh_get_result.",
      inputSchema: {
        task_id: z.string().min(1).describe("Task id returned by dsh_start_task."),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(config.limits.maxWaitSeconds)
          .optional()
          .default(0)
          .describe("Wait up to this many seconds for a terminal state.")
      },
      outputSchema: statusOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    guarded(logger, "dsh_get_status", async ({ task_id, wait_seconds }) => {
      const task = await tasks.waitFor(task_id, wait_seconds);
      return textResult(tasks.publicStatus(task));
    })
  );

  server.registerTool(
    "dsh_get_result",
    {
      title: "Get DSH task result",
      description:
        "Return the final answer, a bounded test-line summary, errors, usage, and timing for a terminal DSH task. " +
        "If the task is still running, use wait_seconds (maximum 25s) rather than repeated immediate calls. " +
        "Review the result before claiming that tests passed.",
      inputSchema: {
        task_id: z.string().min(1).describe("Task id returned by dsh_start_task."),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(config.limits.maxWaitSeconds)
          .optional()
          .default(0)
          .describe("Wait up to this many seconds for a terminal state."),
        max_chars: z
          .number()
          .int()
          .min(1_000)
          .max(20_000)
          .optional()
          .describe("Maximum characters of final result text to return."),
        include_logs: z
          .boolean()
          .optional()
          .default(false)
          .describe("Include a short redacted stderr excerpt. Off by default.")
      },
      outputSchema: resultOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    guarded(logger, "dsh_get_result", async ({ task_id, wait_seconds, max_chars, include_logs }) => {
      const task = await tasks.waitFor(task_id, wait_seconds);
      const maxChars = Math.min(
        config.limits.maxResultChars,
        Math.max(1_000, max_chars ?? config.limits.maxResultChars)
      );
      const payload = tasks.publicResult(task, {
        maxChars,
        includeLogs: include_logs === true
      });
      return textResult(payload, maxChars + 4_000);
    })
  );

  server.registerTool(
    "dsh_cancel_task",
    {
      title: "Cancel a DSH task",
      description:
        "Terminate a running DSH task and its process tree. Cancellation is idempotent: if the task already finished, returns cancelled=false. " +
        "Only use when the user asks to stop, or when a task is clearly runaway.",
      inputSchema: {
        task_id: z.string().min(1).describe("Task id to cancel."),
        reason: z.string().max(500).optional().describe("Short reason shown in local bridge logs.")
      },
      outputSchema: cancelOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    guarded(logger, "dsh_cancel_task", async ({ task_id, reason }) => {
      const payload = await tasks.cancel(task_id, reason);
      return textResult(payload);
    })
  );

  server.registerTool(
    "dsh_list_tasks",
    {
      title: "List DSH tasks",
      description:
        "List the bounded set of DSH tasks retained by this MCP server process, newest first. Use to recover a task id; task state is in memory and does not survive a server restart.",
      inputSchema: {},
      outputSchema: listOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    guarded(logger, "dsh_list_tasks", async () => {
      const payload = tasks.publicList();
      return textResult(payload);
    })
  );
}

export const BRIDGE_INSTRUCTIONS = [
  "ChatGPT-DSH Bridge dispatches local coding work to DeepSeek Harness (DSH) headless.",
  "Respect three conversation modes: AUTO (default; use DSH only when local execution is actually needed), GPT_ONLY (never call DSH tools), DSH_REQUIRED (plan, dispatch, then review DSH output).",
  "Default to read-only. Never request workspace-write without explicit user approval in the current conversation; workspace-write also requires a valid local write grant created by the user. Do not ask the user for a token.",
  "Call dsh_health_check before the first task. Start a task, then use bounded wait_seconds calls (at most 6) rather than tight polling. Call dsh_get_result before reporting completion, and review tests and errors.",
  "Never claim files changed or tests passed unless DSH output supports it. Do not expose credentials or tokens.",
  "Host limitation: local MCP tools may not be available in ordinary ChatGPT Chat. Only claim success after a real tool call returns."
].join(" ");
