#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");
const serverEntry = path.join(pluginRoot, "server", "index.js");

function log(message, fields = {}) {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), message, ...fields })}\n`);
}

function structured(result) {
  return result?.structuredContent ?? result ?? null;
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result?.isError) {
    const text = result.content?.find?.((item) => item.type === "text")?.text || "unknown tool error";
    throw new Error(`${name} failed: ${text}`);
  }
  return structured(result);
}

const env = { ...process.env };
const args = process.argv.slice(2);
const probe = args.includes("--probe");
const workspaceIndex = args.indexOf("--workspace");
const workspace = workspaceIndex >= 0 ? args[workspaceIndex + 1] : null;
const skipTask = workspaceIndex < 0 || args.includes("--skip-task");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: pluginRoot,
  env,
  stderr: "pipe"
});

const stderrChunks = [];
transport.stderr?.on("data", (chunk) => {
  const text = chunk.toString("utf8");
  stderrChunks.push(text);
  if (stderrChunks.length > 200) stderrChunks.shift();
  if (process.env.DSH_BRIDGE_SMOKE_VERBOSE === "1") process.stderr.write(text);
});

const client = new Client({ name: "chatgpt-dsh-bridge-smoke", version: "0.1.0" });

try {
  if (!skipTask && !workspace) throw new Error("--workspace requires an absolute project directory.");
  await client.connect(transport);
  const tools = await client.listTools();
  if (tools.tools.length !== 6) throw new Error("Expected six MCP tools.");
  log("tools_discovered", { count: tools.tools.length, names: tools.tools.map((tool) => tool.name) });

  const health = await call(client, "dsh_health_check", { probe });
  log("health", health);
  if (!health.ok) throw new Error("DSH CLI or profile health check failed.");

  if (!skipTask) {
    const started = await call(client, "dsh_start_task", {
      task: "Reply with exactly DSH_BRIDGE_SMOKE_OK. Do not use any tools and do not modify any files.",
      workspace,
      permission_mode: "read-only",
      title: "Smoke test read-only OK",
      timeout_seconds: 180
    });
    log("task_started", started);

    let status = started;
    for (let attempt = 0; attempt < 8 && !status.task.terminal; attempt += 1) {
      status = await call(client, "dsh_get_status", {
        task_id: started.task.id,
        wait_seconds: 20
      });
      log("task_status", { attempt: attempt + 1, task_id: status.task.id, status: status.task.status });
    }

    const result = await call(client, "dsh_get_result", {
      task_id: started.task.id,
      wait_seconds: 20,
      include_logs: true
    });
    log("task_result", result);
    if (!result.terminal) {
      throw new Error("Task did not finish after bounded polling.");
    }
    if (result.status !== "completed") {
      throw new Error(`Task ended with ${result.status}: ${JSON.stringify(result.result?.errors ?? [])}`);
    }
    if (!String(result.result?.text || "").includes("DSH_BRIDGE_SMOKE_OK")) {
      throw new Error(`Unexpected final result: ${result.result?.text}`);
    }
  }

  log("smoke_ok", { probe, task_skipped: skipTask });
} catch (error) {
  log("smoke_failed", { message: error.message, stderr_tail: stderrChunks.join("").slice(-4_000) });
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
