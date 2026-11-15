import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildLaunchSpec } from "./dsh-locator.js";
import { BridgeError } from "./errors.js";
import { clipText, redactSecrets, stripAnsi } from "./text.js";

const BRIDGE_POLICY = [
  "[ChatGPT-DSH Bridge execution policy]",
  "You are executing a task dispatched by the ChatGPT-DSH Bridge.",
  "Work only inside the current workspace. Do not read or write credentials, browser cookies, SSH keys, cloud tokens, or DSH configuration.",
  "Do not run git push, deploy, publish, release, destructive project deletion, or global/system configuration changes.",
  "Do not exfiltrate files or secrets. If the task requires any of these actions, stop and report that it is out of scope.",
  "Read-only tasks must not modify files. A workspace-write task has been explicitly authorized by the user through the bridge.",
  "[/ChatGPT-DSH Bridge execution policy]"
].join("\n");

export function buildCleanEnv(config, taskId) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    const name = key.toUpperCase();
    // Never leak bridge secrets (notably DSH_BRIDGE_WRITE_TOKEN) or the
    // desktop app's current DSH session/profile into the child process.
    if (name.startsWith("DSH_BRIDGE_") || [
      "DSH_HOME",
      "ELECTRON_RUN_AS_NODE",
      "NODE_OPTIONS",
      "DSH_SESSION_ID",
      "DSH_PROFILE",
      "DSH_PROFILE_DIR",
      "DSH_SHELL",
      "DSH_WEB_URL",
      "DSH_PERMISSION_MODE"
    ].includes(name)) {
      delete env[key];
    }
  }
  env.DSH_HOME = config.dsh.dshHome;
  env.ELECTRON_RUN_AS_NODE = "1";
  env.DSH_BRIDGE_TASK_ID = taskId;
  env.NO_COLOR = "1";
  env.FORCE_COLOR = "0";
  return env;
}

export function composeTaskPrompt(task, workspace, permissionMode) {
  return [
    BRIDGE_POLICY,
    "",
    `Workspace: ${workspace}`,
    `Permission mode: ${permissionMode}`,
    "",
    "[User task]",
    task,
    "[/User task]"
  ].join("\n");
}

export class DshRunner {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    this.launchSpec = null;
  }

  getLaunchSpec() {
    if (!this.launchSpec) this.launchSpec = buildLaunchSpec(this.config);
    return this.launchSpec;
  }

  buildArgs({ mode, extraArgs = [] }) {
    const spec = this.getLaunchSpec();
    return [
      ...spec.prefixArgs,
      "--profile",
      this.config.dsh.profile,
      ...extraArgs,
      "--json",
      "--permission-mode",
      mode,
      "--approval-policy",
      "never",
      "-"
    ];
  }

  baseEnv() {
    return buildCleanEnv(this.config, "health-check");
  }

  spawnRaw(args, { cwd, env, stdio }) {
    const spec = this.getLaunchSpec();
    return spawn(spec.command, args, {
      cwd,
      env: env ?? this.baseEnv(),
      shell: false,
      windowsHide: true,
      stdio
    });
  }

  async runToCompletion(args, { cwd, timeoutMs, maxStdoutBytes = 512_000, maxStderrBytes = 64_000 } = {}) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawnRaw(args, {
          cwd,
          stdio: ["ignore", "pipe", "pipe"]
        });
      } catch (error) {
        reject(new BridgeError("DSH_SPAWN_FAILED", `Unable to start DSH: ${error.message}`));
        return;
      }

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let forceTimer;
      let timer;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceTimer) clearTimeout(forceTimer);
        fn(value);
      };
      timer = setTimeout(() => {
        timedOut = true;
        terminateProcessTree(child, this.logger);
        forceTimer = setTimeout(() => {
          settle(resolve, {
            code: null,
            signal: null,
            timedOut: true,
            stdout,
            stderr,
            elapsedMs: Date.now() - started
          });
        }, 5_000);
      }, Math.max(1_000, timeoutMs));

      child.stdout?.on("data", (chunk) => {
        if (stdout.length < maxStdoutBytes) stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk) => {
        if (stderr.length < maxStderrBytes) stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        settle(reject, new BridgeError("DSH_SPAWN_FAILED", `Unable to start DSH: ${error.message}`));
      });
      child.on("close", (code, signal) => {
        settle(resolve, {
          code,
          signal,
          timedOut,
          stdout,
          stderr,
          elapsedMs: Date.now() - started
        });
      });
    });
  }

  async getVersion() {
    const spec = this.getLaunchSpec();
    const result = await this.runToCompletion([...spec.prefixArgs, "--version"], {
      timeoutMs: 20_000
    });
    const text = redactSecrets(stripAnsi(result.stdout || result.stderr)).trim();
    if (result.code !== 0) {
      throw new BridgeError("DSH_VERSION_FAILED", `DSH --version failed (exit ${result.code}): ${clipText(text, 500).text}`);
    }
    return { version: (text.split(/\r?\n/).find(Boolean) || "unknown").slice(0, 200) };
  }

  async dumpConfigSummary() {
    const spec = this.getLaunchSpec();
    const result = await this.runToCompletion(
      [...spec.prefixArgs, "--profile", this.config.dsh.profile, "--dump-config"],
      { timeoutMs: 40_000, maxStdoutBytes: 4_000_000 }
    );
    const output = stripAnsi(result.stdout || "");
    const provider =
      output.match(/provider:\s*['"]?([A-Za-z0-9._-]+)['"]?/i)?.[1] ||
      output.match(/providerName:\s*['"]?([A-Za-z0-9._-]+)['"]?/i)?.[1] ||
      null;
    const model = output.match(/model:\s*['"]?([A-Za-z0-9._-]+)['"]?/i)?.[1] || null;
    const hasHeadless = /dsh-headless/.test(output);
    const hasDeepseekAccount = /dsh-deepseek-account-platform/.test(output);

    return {
      exitCode: result.code,
      provider,
      model,
      hasHeadless,
      hasDeepseekAccount,
      timedOut: result.timedOut,
      stderrTail: clipText(redactSecrets(result.stderr), 1_000, { keepTail: true }).text
    };
  }

  startHeadless({ task, workspace, mode, timeoutMs, taskId }) {
    if (!["read-only", "workspace-write"].includes(mode)) {
      throw new BridgeError("PERMISSION_MODE_INVALID", "Only read-only and workspace-write are allowed.");
    }
    if (!workspace || !path.isAbsolute(workspace)) {
      throw new BridgeError("WORKSPACE_INVALID", "A validated absolute workspace is required.");
    }

    const args = this.buildArgs({ mode });
    const env = buildCleanEnv(this.config, taskId);
    const child = this.spawnRaw(args, {
      cwd: workspace,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const prompt = composeTaskPrompt(task, workspace, mode);
    child.stdin.on("error", () => {
      // A CLI that exits before consuming the prompt can close its stdin first.
      // The process error/close handlers still report the task outcome.
    });
    child.stdin.end(prompt, "utf8");

    const timer = setTimeout(() => {
      this.logger.warn("task_timeout", { task_id: taskId, timeout_ms: timeoutMs });
      terminateProcessTree(child, this.logger);
      child.emit("bridge_timeout");
    }, timeoutMs);
    timer.unref?.();

    return {
      child,
      cancel: (reason) => {
        this.logger.warn("task_cancel_requested", { task_id: taskId, reason });
        terminateProcessTree(child, this.logger);
      },
      disposeTimer: () => clearTimeout(timer)
    };
  }

  async probeModel() {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "chatgpt-dsh-bridge-health-"));
    const taskId = `health-${Date.now()}`;
    try {
      const handle = this.startHeadless({
        task: "Reply with exactly DSH_BRIDGE_OK. Do not use tools and do not modify files.",
        workspace: tempRoot,
        mode: "read-only",
        timeoutMs: this.config.limits.healthProbeTimeoutSeconds * 1_000,
        taskId
      });
      const started = Date.now();
      return await new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let settled = false;
        let fallbackTimer;
        const finish = (payload) => {
          if (settled) return;
          settled = true;
          if (fallbackTimer) clearTimeout(fallbackTimer);
          handle.disposeTimer();
          resolve(payload);
        };
        const fallbackMs = (this.config.limits.healthProbeTimeoutSeconds + 10) * 1_000;
        fallbackTimer = setTimeout(() => {
          finish({
            checked: true,
            ok: false,
            latency_ms: Date.now() - started,
            response_excerpt: null,
            error: "Model probe did not exit after its timeout."
          });
        }, fallbackMs);
        fallbackTimer.unref?.();

        handle.child.stdout?.on("data", (chunk) => {
          if (stdout.length < 1_000_000) stdout += chunk.toString("utf8");
        });
        handle.child.stderr?.on("data", (chunk) => {
          if (stderr.length < 64_000) stderr += chunk.toString("utf8");
        });
        handle.child.on("bridge_timeout", () => {
          timedOut = true;
        });
        handle.child.on("error", (error) => {
          finish({
            checked: true,
            ok: false,
            latency_ms: Date.now() - started,
            response_excerpt: null,
            error: redactSecrets(error.message)
          });
        });
        handle.child.on("close", (code) => {
          const finalEvent = parseFinalEvent(stdout);
          const response = finalEvent?.text || null;
          finish({
            checked: true,
            ok: !timedOut && code === 0 && typeof response === "string" && response.includes("DSH_BRIDGE_OK"),
            latency_ms: Date.now() - started,
            response_excerpt: response ? clipText(redactSecrets(response), 300).text : null,
            error: timedOut
              ? "Model probe timed out."
              : code !== 0
                ? clipText(redactSecrets(stderr), 500, { keepTail: true }).text
                : null
          });
        });
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export function parseFinalEvent(stdout) {
  const lines = String(stdout ?? "").split(/\r?\n/);
  let final = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed);
      if (event?.type === "final") final = event;
    } catch {
      // DSH writes diagnostics to stderr. Ignore any non-protocol line here.
    }
  }
  return final;
}

export function terminateProcessTree(child, logger) {
  if (!child || child.killed || !child.pid) return;
  try {
    if (process.platform === "win32") {
      const taskkill = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
      const killer = spawn(taskkill, ["/pid", String(child.pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore"
      });
      killer.on("error", (error) => logger?.warn("taskkill_failed", { message: error.message }));
    } else {
      child.kill("SIGKILL");
    }
  } catch (error) {
    logger?.warn("terminate_failed", { message: error.message });
  }
}
