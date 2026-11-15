import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPermissionMode,
  authorizeWorkspaceWrite,
  validateTaskText
} from "../../server/lib/policy.js";
import { createWriteGrant, ensureWriteAuthorizerKey } from "../../server/lib/write-grant.js";
import { BridgeError } from "../../server/lib/errors.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sandboxRoot = path.join(path.dirname(projectRoot), `.bridge-policy-test-${process.pid}`);
let workspace;
let config;

function makeConfig(overrides = {}) {
  return {
    bridge: { pluginRoot: projectRoot },
    dsh: { dshHome: path.join(workspace, "dsh-home") },
    security: {
      allowedRoots: [sandboxRoot],
      writeModeEnabled: true,
      writeReady: true,
      writeAuthorization: "local-grant",
      writeAuthorizerKeyFile: path.join(sandboxRoot, "write-authorizer.key"),
      writeGrantFile: path.join(sandboxRoot, "write-grant.json"),
      runtimeStatusFile: path.join(sandboxRoot, "runtime-status.json"),
      ...overrides
    }
  };
}

test.before(async () => {
  await rm(sandboxRoot, { recursive: true, force: true }).catch(() => {});
  workspace = await mkdtemp(`${sandboxRoot}-`);
  config = makeConfig();
});

test.after(async () => {
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
  await rm(sandboxRoot, { recursive: true, force: true }).catch(() => {});
});

test("rejects danger-full-access and unknown modes", () => {
  assert.throws(() => assertPermissionMode("danger-full-access"), (error) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, "PERMISSION_MODE_INVALID");
    return true;
  });
  assert.doesNotThrow(() => assertPermissionMode("read-only"));
  assert.doesNotThrow(() => assertPermissionMode("workspace-write"));
});

test("workspace-write needs a valid local grant, not a token", async () => {
  await ensureWriteAuthorizerKey(config);
  await assert.rejects(
    authorizeWorkspaceWrite(config, {
      permissionMode: "workspace-write",
      allowWrite: true,
      workspace
    }),
    (error) => error.code === "WRITE_LOCAL_APPROVAL_REQUIRED"
  );

  const grant = await createWriteGrant(config, { workspace, minutes: 30 });
  const authorization = await authorizeWorkspaceWrite(config, {
    permissionMode: "workspace-write",
    allowWrite: true,
    workspace
  });
  assert.equal(authorization.authorization, "local-grant");
  assert.equal(authorization.grant_id, grant.grant_id);
  assert.ok(authorization.expires_at);
});

test("workspace-write still requires the model-side allow_write signal", async () => {
  await createWriteGrant(config, { workspace, minutes: 30 });
  await assert.rejects(
    authorizeWorkspaceWrite(config, {
      permissionMode: "workspace-write",
      allowWrite: false,
      workspace
    }),
    (error) => error.code === "WRITE_APPROVAL_REQUIRED"
  );
});

test("write mode disabled rejects before checking a grant", async () => {
  await createWriteGrant(config, { workspace, minutes: 30 });
  await assert.rejects(
    authorizeWorkspaceWrite(makeConfig({ writeModeEnabled: false }), {
      permissionMode: "workspace-write",
      allowWrite: true,
      workspace
    }),
    (error) => error.code === "WRITE_MODE_DISABLED"
  );
});

test("grant is scoped to the exact workspace and detects tampering/expiry", async () => {
  await createWriteGrant(config, { workspace, minutes: 30 });
  const otherWorkspace = await mkdtemp(`${sandboxRoot}-other-`);
  try {
    await assert.rejects(
      authorizeWorkspaceWrite(config, {
        permissionMode: "workspace-write",
        allowWrite: true,
        workspace: otherWorkspace
      }),
      (error) => error.code === "WRITE_LOCAL_APPROVAL_REQUIRED"
    );

    const grantPath = config.security.writeGrantFile;
    const original = JSON.parse(await readFile(grantPath, "utf8"));
    original.payload.workspace = otherWorkspace;
    await writeFile(grantPath, JSON.stringify(original), "utf8");
    await assert.rejects(
      authorizeWorkspaceWrite(config, {
        permissionMode: "workspace-write",
        allowWrite: true,
        workspace: otherWorkspace
      }),
      (error) => error.code === "WRITE_LOCAL_APPROVAL_REQUIRED"
    );

    const expired = await createWriteGrant(config, {
      workspace,
      minutes: 1,
      now: Date.now() - 2 * 60_000
    });
    assert.ok(expired.grant_id);
    await assert.rejects(
      authorizeWorkspaceWrite(config, {
        permissionMode: "workspace-write",
        allowWrite: true,
        workspace
      }),
      (error) => error.code === "WRITE_LOCAL_APPROVAL_REQUIRED"
    );
  } finally {
    await rm(otherWorkspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("read-only never requires a local grant", async () => {
  const result = await authorizeWorkspaceWrite(config, {
    permissionMode: "read-only",
    allowWrite: false,
    workspace
  });
  assert.equal(result.required, false);
});

test("task text is non-empty, bounded, and NUL-free", () => {
  assert.equal(validateTaskText("  do work  ", 100), "do work");
  assert.throws(() => validateTaskText("", 100), (error) => error.code === "TASK_INVALID");
  assert.throws(() => validateTaskText("a".repeat(101), 100), (error) => error.code === "TASK_TOO_LARGE");
  assert.throws(() => validateTaskText("bad\0task", 100), (error) => error.code === "TASK_INVALID");
});
