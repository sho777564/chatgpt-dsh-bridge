import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(projectRoot, "server", "index.js");
const dshCli = path.join(projectRoot, "test", "fixtures", "fake-dsh.mjs");

function toolText(result) {
  return result?.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n") ?? "";
}

async function call(client, name, args = {}) {
  return client.callTool({ name, arguments: args });
}

test("MCP discovery, health, read-only task lifecycle, and write guard", { timeout: 30_000 }, async () => {
  const testRoot = await mkdtemp(
    path.join(path.dirname(projectRoot), `.bridge-it-${process.pid}-`)
  );
  const workspace = path.join(testRoot, "workspace");
  await mkdir(workspace);
  const configPath = path.join(testRoot, "unused-bridge-config.json");
  const env = { ...process.env };
  env.DSH_BRIDGE_DSH_CLI = dshCli;
  env.DSH_BRIDGE_CONFIG = configPath;
  env.DSH_BRIDGE_ALLOWED_ROOTS = workspace;
  env.DSH_HOME = path.join(testRoot, "fake-dsh-home");
  env.DSH_BRIDGE_RUNTIME_STATUS_FILE = path.join(testRoot, "runtime-status.json");
  delete env.DSH_BRIDGE_WRITE_KEY_FILE;
  delete env.DSH_BRIDGE_WRITE_GRANT_FILE;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: projectRoot,
    env,
    stderr: "pipe"
  });
  const stderrChunks = [];
  transport.stderr?.on("data", (chunk) => {
    stderrChunks.push(chunk.toString("utf8"));
    if (stderrChunks.length > 500) stderrChunks.shift();
  });

  const client = new Client({ name: "bridge-integration-test", version: "0.1.0" });

  try {
    await client.connect(transport);

    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "dsh_cancel_task",
      "dsh_get_result",
      "dsh_get_status",
      "dsh_health_check",
      "dsh_list_tasks",
      "dsh_start_task"
    ]);
    const healthTool = listed.tools.find((tool) => tool.name === "dsh_health_check");
    assert.equal(healthTool.annotations.readOnlyHint, true);
    const startTool = listed.tools.find((tool) => tool.name === "dsh_start_task");
    assert.equal(startTool.annotations.destructiveHint, true);
    assert.ok(startTool.inputSchema.properties.workspace);
    assert.equal(startTool.inputSchema.properties.write_approval_token, undefined);
    assert.ok(startTool.inputSchema.properties.allow_write);

    const healthResult = await call(client, "dsh_health_check", { probe: false });
    assert.equal(healthResult.isError, undefined);
    const health = healthResult.structuredContent;
    assert.equal(health.ok, true);
    assert.equal(health.dsh.found, true);
    assert.match(health.dsh.version, /^\d+\.\d+\.\d+/);
    assert.equal(health.dsh.provider, "deepseek-account");
    assert.equal(health.dsh.credentials_present, false);
    assert.equal(health.model_probe.checked, false);

    const badWorkspace = await call(client, "dsh_start_task", {
      task: "do nothing",
      workspace: path.parse(workspace).root,
      permission_mode: "read-only"
    });
    assert.equal(badWorkspace.isError, true);
    assert.match(toolText(badWorkspace), /WORKSPACE_SENSITIVE|WORKSPACE_TOO_BROAD/);

    const writeGuard = await call(client, "dsh_start_task", {
      task: "write nothing",
      workspace,
      permission_mode: "workspace-write",
      allow_write: true
    });
    assert.equal(writeGuard.isError, true);
    assert.match(toolText(writeGuard), /WRITE_MODE_DISABLED|WRITE_LOCAL_APPROVAL_REQUIRED/);

    const started = await call(client, "dsh_start_task", {
      task: "Reply with exactly DSH_BRIDGE_INTEGRATION_OK. Do not use any tools and do not modify any files.",
      workspace,
      permission_mode: "read-only",
      title: "integration read-only OK",
      timeout_seconds: 180
    });
    assert.equal(started.isError, undefined);
    const startData = started.structuredContent;
    assert.equal(startData.ok, true);
    assert.equal(startData.task.status, "running");
    assert.match(startData.task.id, /^dsh-/);

    let statusData = startData;
    for (let attempt = 0; attempt < 8 && !statusData.task.terminal; attempt += 1) {
      const status = await call(client, "dsh_get_status", {
        task_id: startData.task.id,
        wait_seconds: 20
      });
      assert.equal(status.isError, undefined);
      statusData = status.structuredContent;
    }
    assert.equal(statusData.task.terminal, true, "task did not reach a terminal state");

    const result = await call(client, "dsh_get_result", {
      task_id: startData.task.id,
      wait_seconds: 5,
      max_chars: 4_000
    });
    assert.equal(result.isError, undefined);
    const resultData = result.structuredContent;
    assert.equal(resultData.terminal, true);
    assert.equal(resultData.status, "completed");
    assert.match(resultData.result.text, /DSH_BRIDGE_INTEGRATION_OK/);
    assert.ok(resultData.result.dsh_session_id.startsWith("session-"));
    assert.equal(resultData.result.exit_code, 0);

    const secondCancel = await call(client, "dsh_cancel_task", {
      task_id: startData.task.id,
      reason: "already done"
    });
    assert.equal(secondCancel.structuredContent.cancelled, false);
    assert.equal(secondCancel.structuredContent.already_terminal, true);

    const list = await call(client, "dsh_list_tasks", {});
    assert.equal(list.structuredContent.ok, true);
    assert.ok(list.structuredContent.tasks.some((task) => task.id === startData.task.id));
    assert.ok(list.structuredContent.count >= 1);
  } catch (error) {
    if (stderrChunks.length) {
      process.stderr.write(`\n--- bridge stderr ---\n${stderrChunks.join("").slice(-6_000)}\n--- end ---\n`);
    }
    throw error;
  } finally {
    await client.close().catch(() => {});
    await rm(testRoot, { recursive: true, force: true }).catch(() => {});
  }
});
