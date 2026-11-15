import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createWriteGrant,
  getWriteGrantStatus,
  revokeWriteGrant,
  verifyWriteGrant
} from "../../server/lib/write-grant.js";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const baseRoot = path.join(path.dirname(projectRoot), `.bridge-perm-test-${process.pid}`);

function makeConfig(base) {
  return {
    bridge: { pluginRoot: projectRoot },
    dsh: { dshHome: path.join(base, "dsh-home") },
    security: {
      allowedRoots: [base],
      writeModeEnabled: true,
      writeReady: true,
      writeAuthorization: "local-grant",
      writeAuthorizerKeyFile: path.join(base, "write-authorizer.key"),
      writeGrantFile: path.join(base, "write-grant.json"),
      runtimeStatusFile: path.join(base, "runtime-status.json")
    }
  };
}

test.before(async () => {
  await rm(baseRoot, { recursive: true, force: true }).catch(() => {});
  await mkdir(baseRoot, { recursive: true });
});

test.after(async () => {
  await rm(baseRoot, { recursive: true, force: true }).catch(() => {});
});

test("permanent grant is valid across processes, has no expiry, and exposes no signature", async () => {
  const base = await mkdtemp(path.join(baseRoot, "persist-"));
  const workspace = await mkdtemp(path.join(base, "ws-"));
  const config = makeConfig(base);
  const grant = await createWriteGrant(config, { workspace, permanent: true });

  assert.equal(grant.permanent, true);
  assert.equal(grant.kind, "permanent");
  assert.equal(grant.expires_at, null);
  assert.equal(grant.signature, undefined);
  assert.equal(grant.directory, undefined);

  const verified = await verifyWriteGrant(config, { workspace });
  assert.equal(verified.valid, true);
  assert.equal(verified.permanent, true);
  assert.equal(verified.expires_at, null);

  const script = path.join(projectRoot, "scripts", "write-grant-status.mjs");
  const childEnv = { ...process.env, DSH_BRIDGE_CONFIG: path.join(base, "bridge.config.json") };
  await writeFile(
    childEnv.DSH_BRIDGE_CONFIG,
    JSON.stringify({
      dshCliPath: "G:\\fake\\dsh.cmd",
      dshProfile: "headless",
      dshHome: path.join(base, "dsh-home"),
      allowedRoots: [base],
      writeModeEnabled: true,
      writeAuthorizerKeyFile: config.security.writeAuthorizerKeyFile,
      writeGrantFile: config.security.writeGrantFile,
      runtimeStatusFile: config.security.runtimeStatusFile
    }),
    "utf8"
  );
  const child = await execFileAsync(process.execPath, [script], {
    cwd: projectRoot,
    env: childEnv,
    timeout: 20_000,
    windowsHide: true
  });
  const childStatus = JSON.parse(child.stdout);
  assert.equal(childStatus.write_grant.valid, true);
  assert.equal(childStatus.write_grant.permanent, true);
  assert.equal(childStatus.write_grant.kind, "permanent");
  assert.equal(childStatus.write_grant.expires_at, null);
});

test("permanent grant rejects another directory and is immediately revocable", async () => {
  const base = await mkdtemp(path.join(baseRoot, "scope-"));
  const workspaceA = await mkdtemp(path.join(base, "a-"));
  const workspaceB = await mkdtemp(path.join(base, "b-"));
  const config = makeConfig(base);
  await createWriteGrant(config, { workspace: workspaceA, permanent: true });

  const cross = await verifyWriteGrant(config, { workspace: workspaceB });
  assert.equal(cross.valid, false);
  assert.equal(cross.reason, "workspace-mismatch");

  const revoked = await revokeWriteGrant(config);
  assert.equal(revoked.revoked, true);
  const after = await verifyWriteGrant(config, { workspace: workspaceA });
  assert.equal(after.valid, false);
  assert.equal(after.reason, "missing");
});

test("replacing the approved directory invalidates a permanent grant", async () => {
  const base = await mkdtemp(path.join(baseRoot, "identity-"));
  const workspace = await mkdtemp(path.join(base, "ws-"));
  const config = makeConfig(base);
  await createWriteGrant(config, { workspace, permanent: true });

  const oldPath = `${workspace}-old`;
  await rename(workspace, oldPath);
  await mkdir(workspace);

  const result = await verifyWriteGrant(config, { workspace });
  assert.equal(result.valid, false);
  assert.ok(["directory-identity-mismatch", "workspace-path-changed"].includes(result.reason));
});

test("junction replacement at the approved path does not bypass the grant", async () => {
  const base = await mkdtemp(path.join(baseRoot, "junction-"));
  const workspace = await mkdtemp(path.join(base, "ws-"));
  const target = await mkdtemp(path.join(base, "target-"));
  const config = makeConfig(base);
  await createWriteGrant(config, { workspace, permanent: true });

  await rm(workspace, { recursive: true, force: true });
  try {
    await symlink(target, workspace, "junction");
  } catch (error) {
    // Directory junctions can be unavailable in constrained test environments.
    return;
  }

  const result = await verifyWriteGrant(config, { workspace });
  assert.equal(result.valid, false);
  assert.ok(["directory-identity-mismatch", "workspace-path-changed"].includes(result.reason));
  await rm(workspace, { force: true }).catch(() => {});
});

test("permanent grants cannot be created with non-interactive --yes", async () => {
  const base = await mkdtemp(path.join(baseRoot, "interactive-"));
  const workspace = await mkdtemp(path.join(base, "ws-"));
  const config = makeConfig(base);
  await writeFile(
    path.join(base, "bridge.config.json"),
    JSON.stringify({
      dshCliPath: "G:\\fake\\dsh.cmd",
      dshProfile: "headless",
      dshHome: path.join(base, "dsh-home"),
      allowedRoots: [base],
      writeModeEnabled: true,
      writeAuthorizerKeyFile: config.security.writeAuthorizerKeyFile,
      writeGrantFile: config.security.writeGrantFile
    }),
    "utf8"
  );

  let failed = false;
  try {
    await execFileAsync(
      process.execPath,
      [
        path.join(projectRoot, "scripts", "approve-write.mjs"),
        "--workspace", workspace,
        "--config", path.join(base, "bridge.config.json"),
        "--permanent",
        "--yes"
      ],
      { cwd: projectRoot, timeout: 20_000, windowsHide: true }
    );
  } catch (error) {
    failed = true;
    assert.match(`${error.stdout}\n${error.stderr}`, /interactive|--yes/i);
  }
  assert.equal(failed, true);

  const status = await getWriteGrantStatus(config);
  assert.equal(status.valid, false);
});

test("authorizer material cannot be stored inside the Bridge source directory", async () => {
  const base = await mkdtemp(path.join(baseRoot, "auth-path-"));
  const workspace = await mkdtemp(path.join(base, "ws-"));
  const config = makeConfig(base);
  config.security.writeAuthorizerKeyFile = path.join(projectRoot, "unsafe-write-authorizer.key");
  config.security.writeGrantFile = path.join(base, "write-grant.json");

  await assert.rejects(
    createWriteGrant(config, { workspace, permanent: true }),
    (error) => error.code === "WRITE_AUTH_PATH_UNSAFE"
  );
});
