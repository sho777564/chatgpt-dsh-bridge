import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { TaskManager } from "../../server/lib/task-manager.js";

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "fake-dsh.mjs"
);

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {}
};

function config() {
  return {
    limits: {
      maxTasks: 5,
      maxConcurrentTasks: 2,
      maxLogBytes: 100_000,
      maxResultChars: 4_000,
      maxWaitSeconds: 5
    }
  };
}

function fakeRunner(mode, delayMs = 50) {
  return {
    startHeadless({ task, timeoutMs }) {
      const child = spawn(
        process.execPath,
        [fixturePath, mode, String(delayMs), `${mode}-${Date.now()}`],
        { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
      );
      child.stdin.end(task);
      const timer = setTimeout(() => {
        child.kill();
        child.emit("bridge_timeout");
      }, timeoutMs);
      return {
        child,
        cancel() {
          child.kill();
        },
        disposeTimer() {
          clearTimeout(timer);
        }
      };
    }
  };
}

async function waitUntilDone(manager, id, seconds = 5) {
  const deadline = Date.now() + seconds * 1_000;
  while (Date.now() < deadline) {
    const task = await manager.waitFor(id, 1);
    if (task.status !== "running") return task;
  }
  throw new Error("fixture did not finish");
}

test("completed task returns final text, tests, and usage", async () => {
  const manager = new TaskManager({ config: config(), runner: fakeRunner("complete"), logger: silentLogger });
  const started = await manager.start({
    task: "run fixture",
    title: "fixture",
    workspace: process.cwd(),
    permissionMode: "read-only",
    timeoutSeconds: 10
  });
  const task = await waitUntilDone(manager, started.task.id);
  assert.equal(task.status, "completed");
  const result = manager.publicResult(task, { maxChars: 4_000 });
  assert.match(result.result.text, /DSH_BRIDGE_FIXTURE_OK/);
  assert.ok(result.result.tests.some((line) => line.includes("PASS fixture test")));
  assert.equal(result.result.usage.totalTokens, 2);
  await manager.shutdown();
});

test("non-zero exit becomes failed with an error", async () => {
  const manager = new TaskManager({ config: config(), runner: fakeRunner("fail"), logger: silentLogger });
  const started = await manager.start({
    task: "fail fixture",
    workspace: process.cwd(),
    permissionMode: "read-only",
    timeoutSeconds: 10
  });
  const task = await waitUntilDone(manager, started.task.id);
  assert.equal(task.status, "failed");
  assert.equal(task.error.code, "DSH_EXIT_NONZERO");
  await manager.shutdown();
});

test("missing final event is a failure, not a false success", async () => {
  const manager = new TaskManager({ config: config(), runner: fakeRunner("no-final"), logger: silentLogger });
  const started = await manager.start({
    task: "no final fixture",
    workspace: process.cwd(),
    permissionMode: "read-only",
    timeoutSeconds: 10
  });
  const task = await waitUntilDone(manager, started.task.id);
  assert.equal(task.status, "failed");
  assert.equal(task.error.code, "FINAL_RESULT_MISSING");
  await manager.shutdown();
});

test("timeout terminates the process and is reported as timed_out", async () => {
  const manager = new TaskManager({ config: config(), runner: fakeRunner("hang"), logger: silentLogger });
  const started = await manager.start({
    task: "hang fixture",
    workspace: process.cwd(),
    permissionMode: "read-only",
    timeoutSeconds: 1
  });
  await sleep(1_200);
  const task = await manager.waitFor(started.task.id, 5);
  assert.equal(task.status, "timed_out");
  assert.equal(task.error.code, "TASK_TIMEOUT");
  await manager.shutdown();
});

test("cancel terminates a running task and is idempotent", async () => {
  const manager = new TaskManager({ config: config(), runner: fakeRunner("hang"), logger: silentLogger });
  const started = await manager.start({
    task: "cancel fixture",
    workspace: process.cwd(),
    permissionMode: "read-only",
    timeoutSeconds: 30
  });
  await sleep(200);
  const cancel = await manager.cancel(started.task.id, "unit test");
  assert.equal(cancel.cancelled, true);
  assert.equal(cancel.status, "cancelled");
  const second = await manager.cancel(started.task.id, "again");
  assert.equal(second.cancelled, false);
  assert.equal(second.already_terminal, true);
  await manager.shutdown();
});

test("task retention and concurrency limits are enforced", async () => {
  const limited = config();
  limited.limits.maxTasks = 2;
  limited.limits.maxConcurrentTasks = 1;
  const manager = new TaskManager({ config: limited, runner: fakeRunner("hang"), logger: silentLogger });
  const first = await manager.start({
    task: "one",
    workspace: process.cwd(),
    permissionMode: "read-only",
    timeoutSeconds: 30
  });
  await assert.rejects(
    manager.start({
      task: "two",
      workspace: process.cwd(),
      permissionMode: "read-only",
      timeoutSeconds: 30
    }),
    (error) => error.code === "TOO_MANY_ACTIVE_TASKS"
  );
  await manager.cancel(first.task.id, "cleanup");
  await manager.shutdown();
});
