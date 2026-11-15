import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateWorkspace } from "../../server/lib/path-policy.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const testRoot = path.join(path.dirname(projectRoot), `.bridge-path-test-${process.pid}`);
let workspace;

function config(overrides = {}) {
  return {
    bridge: { pluginRoot: projectRoot },
    dsh: { dshHome: path.join(os.homedir(), ".dsh") },
    security: {
      allowedRoots: [testRoot],
      writeModeEnabled: true,
      ...overrides
    }
  };
}

test.before(async () => {
  await mkdir(testRoot, { recursive: true });
  workspace = await mkdtemp(path.join(testRoot, "case-"));
});

test.after(async () => {
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
  await rm(testRoot, { recursive: true, force: true }).catch(() => {});
});

test("accepts an absolute folder outside sensitive roots", async () => {
  const resolved = await validateWorkspace(workspace, config(), { permissionMode: "read-only" });
  assert.equal(path.resolve(resolved), path.resolve(workspace));
});

test("rejects relative paths and non-directories", async () => {
  await assert.rejects(
    validateWorkspace("relative\\project", config(), { permissionMode: "read-only" }),
    (error) => error.code === "WORKSPACE_INVALID"
  );
  await assert.rejects(
    validateWorkspace(path.join(workspace, "missing"), config(), { permissionMode: "read-only" }),
    (error) => error.code === "WORKSPACE_NOT_FOUND"
  );
});

test("rejects the drive root and sensitive DSH/SSH directories", async () => {
  await assert.rejects(
    validateWorkspace(path.parse(workspace).root, config(), { permissionMode: "read-only" }),
    (error) => ["WORKSPACE_TOO_BROAD", "WORKSPACE_SENSITIVE"].includes(error.code)
  );
  await assert.rejects(
    validateWorkspace(path.join(os.homedir(), ".ssh"), config(), { permissionMode: "read-only" }),
    (error) => error.code === "WORKSPACE_SENSITIVE"
  );
  await assert.rejects(
    validateWorkspace(path.join(os.homedir(), ".dsh"), config(), { permissionMode: "read-only" }),
    (error) => error.code === "WORKSPACE_SENSITIVE"
  );
});

test("rejects the bridge plugin directory", async () => {
  await assert.rejects(
    validateWorkspace(projectRoot, config(), { permissionMode: "read-only" }),
    (error) => error.code === "WORKSPACE_SENSITIVE"
  );
  await assert.rejects(
    validateWorkspace(path.dirname(projectRoot), config({ allowedRoots: [path.dirname(projectRoot)] })),
    (error) => error.code === "WORKSPACE_SENSITIVE"
  );
});

test("an empty allowlist permits no workspace, including read-only", async () => {
  await assert.rejects(
    validateWorkspace(workspace, config({ allowedRoots: [] })),
    (error) => error.code === "WORKSPACE_ROOTS_REQUIRED"
  );
});

test("rejects a junction that resolves into the bridge source directory", async () => {
  const link = path.join(workspace, "bridge-source-link");
  try {
    await symlink(projectRoot, link, "junction");
  } catch {
    return;
  }
  await assert.rejects(
    validateWorkspace(link, config(), { permissionMode: "read-only" }),
    (error) => error.code === "WORKSPACE_SENSITIVE"
  );
  await rm(link, { force: true }).catch(() => {});
});

test("enforces allowedRoots when configured", async () => {
  const allowed = await validateWorkspace(workspace, config({ allowedRoots: [testRoot] }), {
    permissionMode: "read-only"
  });
  assert.ok(allowed);

  await assert.rejects(
    validateWorkspace(testRoot, config({ allowedRoots: [workspace] }), {
      permissionMode: "read-only"
    }),
    (error) => error.code === "WORKSPACE_OUTSIDE_ALLOWED_ROOTS"
  );
});
