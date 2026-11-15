import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createWriteGrant, revokeWriteGrant } from "../server/lib/write-grant.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dshCli = path.join(projectRoot, "test", "fixtures", "fake-dsh.mjs");
const baseRoot = path.join(path.dirname(projectRoot), `.bridge-perm-server-test-${process.pid}`);

async function connect(configPath) {
  const env = { ...process.env };
  env.DSH_BRIDGE_CONFIG = configPath;
  env.DSH_BRIDGE_DSH_CLI = dshCli;
  env.DSH_BRIDGE_ALLOWED_ROOTS = baseRoot;
  env.DSH_HOME = path.join(baseRoot, "dsh-home");
  env.DSH_BRIDGE_RUNTIME_STATUS_FILE = path.join(baseRoot, "runtime-status.json");
  delete env.DSH_BRIDGE_WRITE_KEY_FILE;
  delete env.DSH_BRIDGE_WRITE_GRANT_FILE;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "server", "index.js")],
    cwd: projectRoot,
    env,
    stderr: "pipe"
  });
  const client = new Client({ name: "permanent-grant-server-test", version: "0.2.0" });
  await client.connect(transport);
  return client;
}

test.after(async () => {
  await rm(baseRoot, { recursive: true, force: true }).catch(() => {});
});

test("permanent grant survives MCP server restart, rejects other dirs, and revokes immediately", { timeout: 30_000 }, async () => {
  await mkdir(baseRoot, { recursive: true });
  const workspace = await mkdtemp(path.join(baseRoot, "ws-"));
  const other = await mkdtemp(path.join(baseRoot, "other-"));
  const configPath = path.join(baseRoot, "bridge.config.json");
  const config = {
    bridge: { pluginRoot: projectRoot },
    dsh: { dshHome: path.join(baseRoot, "dsh-home") },
    security: {
      allowedRoots: [baseRoot],
      writeModeEnabled: true,
      writeReady: true,
      writeAuthorization: "local-grant",
      writeAuthorizerKeyFile: path.join(baseRoot, "write-authorizer.key"),
      writeGrantFile: path.join(baseRoot, "write-grant.json"),
      runtimeStatusFile: path.join(baseRoot, "runtime-status.json")
    }
  };

  await writeFile(
    configPath,
    JSON.stringify({
      dshCliPath: dshCli,
      dshProfile: "headless",
      dshHome: path.join(baseRoot, "dsh-home"),
      allowedRoots: [baseRoot],
      writeModeEnabled: true,
      writeAuthorizerKeyFile: config.security.writeAuthorizerKeyFile,
      writeGrantFile: config.security.writeGrantFile,
      runtimeStatusFile: config.security.runtimeStatusFile
    }),
    "utf8"
  );

  let client = await connect(configPath);
  try {
    const before = await client.callTool({ name: "dsh_health_check", arguments: { probe: false } });
    assert.equal(before.structuredContent.security.write_ready, false);
    const grant = await createWriteGrant(config, { workspace, permanent: true });
    assert.equal(grant.permanent, true);
    const health = await client.callTool({ name: "dsh_health_check", arguments: { probe: false } });
    assert.equal(health.isError, undefined);
    assert.equal(health.structuredContent.security.write_ready, true);
    assert.equal(health.structuredContent.security.write_grant.valid, true);
    assert.equal(health.structuredContent.security.write_grant.permanent, true);
    assert.equal(health.structuredContent.security.write_grant.expires_at, null);

    const started = await client.callTool({
      name: "dsh_start_task",
      arguments: {
        task: "Reply with exactly PERMANENT_GRANT_OK. Do not use tools and do not modify files.",
        workspace,
        permission_mode: "workspace-write",
        allow_write: true,
        title: "permanent grant write authorization",
        timeout_seconds: 180
      }
    });
    assert.equal(started.isError, undefined);
    let status = started.structuredContent;
    for (let attempt = 0; attempt < 6 && !status.task.terminal; attempt += 1) {
      const polled = await client.callTool({
        name: "dsh_get_status",
        arguments: { task_id: status.task.id, wait_seconds: 20 }
      });
      status = polled.structuredContent;
    }
    assert.equal(status.task.terminal, true);
    const result = await client.callTool({
      name: "dsh_get_result",
      arguments: { task_id: status.task.id, wait_seconds: 5 }
    });
    assert.equal(result.structuredContent.status, "completed");
    assert.match(result.structuredContent.result.text, /PERMANENT_GRANT_OK/);
  } finally {
    await client.close();
  }

  // A new MCP server process must read the same permanent grant from disk.
  client = await connect(configPath);
  try {
    const health2 = await client.callTool({ name: "dsh_health_check", arguments: { probe: false } });
    assert.equal(health2.structuredContent.security.write_grant.valid, true);
    assert.equal(health2.structuredContent.security.write_grant.permanent, true);

    const cross = await client.callTool({
      name: "dsh_start_task",
      arguments: {
        task: "write nothing",
        workspace: other,
        permission_mode: "workspace-write",
        allow_write: true
      }
    });
    assert.equal(cross.isError, true);
    assert.match(
      cross.content.filter((item) => item.type === "text").map((item) => item.text).join("\n"),
      /WRITE_LOCAL_APPROVAL_REQUIRED/
    );

    const revoked = await revokeWriteGrant(config);
    assert.equal(revoked.revoked, true);

    const afterRevoke = await client.callTool({ name: "dsh_health_check", arguments: { probe: false } });
    assert.equal(afterRevoke.structuredContent.security.write_grant.valid, false);
  } finally {
    await client.close();
  }

  // Revocation also persists across a new server process.
  client = await connect(configPath);
  try {
    const afterRestart = await client.callTool({ name: "dsh_health_check", arguments: { probe: false } });
    assert.equal(afterRestart.structuredContent.security.write_grant.valid, false);
  } finally {
    await client.close();
    await rm(baseRoot, { recursive: true, force: true }).catch(() => {});
  }
});
