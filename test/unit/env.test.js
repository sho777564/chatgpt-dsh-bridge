import test from "node:test";
import assert from "node:assert/strict";
import { buildCleanEnv } from "../../server/lib/dsh-runner.js";

test("child environment drops bridge secrets and desktop session state", () => {
  const previous = { ...process.env };
  try {
    process.env.DSH_BRIDGE_WRITE_TOKEN = "super-secret-token";
    process.env.DSH_BRIDGE_CONFIG = "C:\\secret\\bridge.config.json";
    process.env.DSH_BRIDGE_DSH_CLI = "G:\\dsh\\dsh.cmd";
    process.env.DSH_SESSION_ID = "session-parent";
    process.env.DSH_PROFILE = "desktop";
    process.env.DSH_PERMISSION_MODE = "danger-full-access";
    process.env.DSH_HOME = "C:\\Users\\test\\.dsh";
    process.env.UNRELATED_TEST_VARIABLE = "kept";

    const env = buildCleanEnv({ dsh: { dshHome: "C:\\Users\\test\\.dsh" } }, "task-123");

    assert.equal(env.DSH_BRIDGE_WRITE_TOKEN, undefined);
    assert.equal(env.DSH_BRIDGE_CONFIG, undefined);
    assert.equal(env.DSH_BRIDGE_DSH_CLI, undefined);
    assert.equal(env.DSH_SESSION_ID, undefined);
    assert.equal(env.DSH_PROFILE, undefined);
    assert.equal(env.DSH_PERMISSION_MODE, undefined);
    assert.equal(env.DSH_BRIDGE_TASK_ID, "task-123");
    assert.equal(env.DSH_HOME, "C:\\Users\\test\\.dsh");
    assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
    assert.equal(env.UNRELATED_TEST_VARIABLE, "kept");
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  }
});
