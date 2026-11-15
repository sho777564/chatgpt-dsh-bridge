import { randomUUID } from "node:crypto";
import { BridgeError } from "./errors.js";
import { createLineStream } from "./line-stream.js";
import {
  clipText,
  extractTestSummary,
  firstMeaningfulError,
  normalizeNewlines,
  redactSecrets,
  safeJsonStringify,
  stripAnsi
} from "./text.js";

const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);

function nowIso() {
  return new Date().toISOString();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTerminal(task) {
  return Boolean(task && TERMINAL.has(task.status));
}

export class TaskManager {
  constructor({ config, runner, logger }) {
    this.config = config;
    this.runner = runner;
    this.logger = logger;
    this.tasks = new Map();
    this.sequence = 0;
  }

  get activeCount() {
    return [...this.tasks.values()].filter((task) => !isTerminal(task)).length;
  }

  pruneIfNeeded() {
    if (this.tasks.size < this.config.limits.maxTasks) return;
    const finished = [...this.tasks.values()]
      .filter(isTerminal)
      .sort((a, b) => a.endedAtMs - b.endedAtMs);
    while (this.tasks.size >= this.config.limits.maxTasks && finished.length > 0) {
      const oldest = finished.shift();
      this.tasks.delete(oldest.id);
    }
  }

  async start({ task, title, workspace, permissionMode, timeoutSeconds }) {
    this.pruneIfNeeded();

    if (this.tasks.size >= this.config.limits.maxTasks) {
      throw new BridgeError(
        "TASK_LIMIT_REACHED",
        `The bridge retains at most ${this.config.limits.maxTasks} tasks. Cancel or wait for older tasks before starting another.`
      );
    }
    if (this.activeCount >= this.config.limits.maxConcurrentTasks) {
      throw new BridgeError(
        "TOO_MANY_ACTIVE_TASKS",
        `At most ${this.config.limits.maxConcurrentTasks} DSH task(s) may run at once. Wait for or cancel an active task first.`
      );
    }

    const id = `dsh-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const createdAt = nowIso();
    const timeoutMs = timeoutSeconds * 1_000;
    const displayTitle = redactSecrets(
      (title && title.trim()) || normalizeNewlines(task).split("\n").find((line) => line.trim()) || "DSH task"
    ).slice(0, 120);

    const taskRecord = {
      id,
      seq: ++this.sequence,
      title: displayTitle,
      workspace,
      permissionMode,
      timeoutSeconds,
      status: "running",
      createdAt,
      createdMs: Date.now(),
      startedAt: createdAt,
      startedMs: Date.now(),
      endedAt: null,
      endedAtMs: null,
      exitCode: null,
      signal: null,
      dshSessionId: null,
      progress: {
        phase: "starting",
        turn: null,
        step: null,
        eventCount: 0,
        lastEventType: null
      },
      finalText: "",
      lastPartialText: "",
      usage: null,
      error: null,
      stderrLines: [],
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      handle: null,
      cancelRequested: false,
      timeoutTriggered: false,
      finalized: false,
      timeoutFallback: null
    };

    this.tasks.set(id, taskRecord);
    this.logger.info("task_started", {
      task_id: id,
      workspace,
      permission_mode: permissionMode,
      timeout_seconds: timeoutSeconds
    });

    try {
      const handle = this.runner.startHeadless({
        task,
        workspace,
        mode: permissionMode,
        timeoutMs,
        taskId: id
      });
      taskRecord.handle = handle;
      this.attachProcess(taskRecord, handle);
      return this.publicStatus(taskRecord, "Task started.");
    } catch (error) {
      this.finalize(taskRecord, {
        status: "failed",
        error: {
          code: error.code || "DSH_START_FAILED",
          message: redactSecrets(error.message || "Unable to start DSH.")
        }
      });
      throw error instanceof BridgeError
        ? error
        : new BridgeError("DSH_START_FAILED", `Unable to start DSH: ${error.message}`);
    }
  }

  attachProcess(task, handle) {
    const { child } = handle;
    const stdout = createLineStream({
      maxChars: 256_000,
      onLine: (line) => this.parseEventLine(task, line),
      onOverflow: () => { task.stdoutTruncated = true; }
    });
    const stderr = createLineStream({
      maxChars: 8_000,
      onLine: (line) => this.recordStderr(task, line),
      onOverflow: () => { task.stderrTruncated = true; }
    });

    child.stdout?.on("data", (chunk) => {
      if (task.finalized) return;
      task.stdoutBytes += chunk.length;
      if (task.stdoutBytes > this.config.limits.maxLogBytes) task.stdoutTruncated = true;
      stdout.write(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      if (task.finalized) return;
      task.stderrBytes += chunk.length;
      if (task.stderrBytes > 64_000) task.stderrTruncated = true;
      stderr.write(chunk);
    });

    child.on("bridge_timeout", () => {
      task.timeoutTriggered = true;
      task.progress.phase = "timing_out";
      // The process tree was already asked to terminate. The close handler
      // records the terminal state once the process actually exits. If the
      // kill is somehow unconfirmed, fail closed instead of polling forever.
      task.timeoutFallback = setTimeout(() => {
        if (task.finalized) return;
        this.finalize(task, {
          status: "timed_out",
          error: {
            code: "TASK_TIMEOUT_UNCONFIRMED",
            message: "DSH task timed out and process exit could not be confirmed."
          }
        });
      }, 7_000);
      task.timeoutFallback.unref?.();
    });

    child.on("error", (error) => {
      if (task.finalized) return;
      this.finalize(task, {
        status: task.cancelRequested ? "cancelled" : "failed",
        error: {
          code: "DSH_SPAWN_FAILED",
          message: redactSecrets(error.message || "Unable to start DSH.")
        }
      });
    });

    child.on("close", (code, signal) => {
      if (task.finalized) return;
      stdout.end();
      stderr.end();
      task.exitCode = code;
      task.signal = signal;
      if (task.timeoutFallback) clearTimeout(task.timeoutFallback);
      handle.disposeTimer?.();

      if (task.cancelRequested) {
        this.finalize(task, { status: "cancelled" });
        return;
      }
      if (task.timeoutTriggered) {
        this.finalize(task, {
          status: "timed_out",
          error: {
            code: "TASK_TIMEOUT",
            message: `DSH task exceeded its ${task.timeoutSeconds}s timeout and was terminated.`
          }
        });
        return;
      }
      if (code === 0) {
        if (task.finalText) {
          this.finalize(task, { status: "completed" });
        } else {
          this.finalize(task, {
            status: "failed",
            error: {
              code: "FINAL_RESULT_MISSING",
              message: "DSH exited successfully but did not emit a final result event."
            }
          });
        }
        return;
      }
      this.finalize(task, {
        status: "failed",
        error: {
          code: "DSH_EXIT_NONZERO",
          message: `DSH exited with code ${code ?? "unknown"}${signal ? ` (signal ${signal})` : ""}.`
        }
      });
    });
  }

  parseEventLine(task, line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (typeof event.type !== "string") return;
    const publicField = (value) => redactSecrets(value).slice(0, 200);
    if ((event.type === "status" || event.type === "final") && event.usage && typeof event.usage === "object") {
      task.usage = Object.fromEntries(Object.entries(event.usage)
        .filter(([key, value]) => /^[a-z][a-z_]{0,63}$/i.test(key) && Number.isFinite(value))
        .slice(0, 32)
        .map(([key, value]) => [publicField(key), value]));
    }
    task.progress.eventCount += 1;
    task.progress.lastEventType = publicField(event.type);

    switch (event.type) {
      case "session":
        if (typeof event.sessionId === "string") task.dshSessionId = publicField(event.sessionId);
        task.progress.phase = "session";
        break;
      case "status":
        if (typeof event.phase === "string") task.progress.phase = publicField(event.phase);
        if (Number.isFinite(event.turn)) task.progress.turn = event.turn;
        if (Number.isFinite(event.step)) task.progress.step = event.step;
        break;
      case "text":
        if (typeof event.text === "string") task.lastPartialText = event.text;
        break;
      case "final":
        if (typeof event.text === "string") task.finalText = event.text;
        task.progress.phase = "final";
        break;
      case "error":
        task.error = {
          code: typeof event.code === "string" ? publicField(event.code) : "DSH_ERROR_EVENT",
          message: redactSecrets(
            typeof event.message === "string" ? event.message : "DSH emitted an error event."
          ).slice(0, this.config.limits.maxErrorChars)
        };
        break;
      default:
        break;
    }
  }

  recordStderr(task, line) {
    const text = stripAnsi(line).trim();
    if (!text) return;
    if (text.length > 1_000 || task.stderrLines.length >= 80) task.stderrTruncated = true;
    task.stderrLines.push(redactSecrets(text).slice(0, 1_000));
    if (task.stderrLines.length > 80) task.stderrLines.shift();
  }

  finalize(task, { status, error = null }) {
    if (!task || task.finalized) return;
    task.finalized = true;
    task.status = status;
    task.endedAt = nowIso();
    task.endedAtMs = Date.now();
    if (task.timeoutFallback) clearTimeout(task.timeoutFallback);
    task.handle?.disposeTimer?.();
    if (error) task.error = error;
    if (!task.finalText && task.lastPartialText) task.finalText = task.lastPartialText;
    if (status === "completed" && !task.finalText) {
      task.status = "failed";
      task.error = {
        code: "FINAL_RESULT_MISSING",
        message: "DSH completed without a final text result."
      };
    }
    this.logger.info("task_finished", {
      task_id: task.id,
      status: task.status,
      exit_code: task.exitCode,
      elapsed_ms: task.endedAtMs - task.startedMs
    });
  }

  getOrThrow(taskId) {
    if (typeof taskId !== "string" || !taskId.trim()) {
      throw new BridgeError("TASK_ID_REQUIRED", "task_id is required.");
    }
    const task = this.tasks.get(taskId.trim());
    if (!task) {
      throw new BridgeError("TASK_NOT_FOUND", `Unknown task_id: ${taskId}. Tasks are kept in memory by this MCP server process.`);
    }
    return task;
  }

  async waitFor(taskId, waitSeconds) {
    const task = this.getOrThrow(taskId);
    const seconds = Math.max(0, Math.min(this.config.limits.maxWaitSeconds, Number(waitSeconds) || 0));
    if (!seconds || isTerminal(task)) return task;

    const deadline = Date.now() + seconds * 1_000;
    while (!isTerminal(task) && Date.now() < deadline) {
      await delay(Math.min(250, Math.max(0, deadline - Date.now())));
    }
    return task;
  }

  publicStatus(task, message = undefined) {
    const terminal = isTerminal(task);
    const elapsedMs = (task.endedAtMs || Date.now()) - task.startedMs;
    return {
      ok: true,
      task: {
        id: task.id,
        title: task.title,
        status: task.status,
        terminal,
        workspace: task.workspace,
        permission_mode: task.permissionMode,
        created_at: task.createdAt,
        started_at: task.startedAt,
        ended_at: task.endedAt,
        elapsed_ms: Math.max(0, elapsedMs),
        timeout_seconds: task.timeoutSeconds,
        exit_code: task.exitCode,
        dsh_session_id: task.dshSessionId,
        progress: {
          phase: task.progress.phase,
          turn: task.progress.turn,
          step: task.progress.step,
          event_count: task.progress.eventCount,
          last_event_type: task.progress.lastEventType
        },
        cancel_requested: task.cancelRequested,
        error: task.error ? { code: task.error.code, message: task.error.message } : null
      },
      terminal,
      ...(message ? { message } : {}),
      ...(terminal
        ? { next: { tool: "dsh_get_result", task_id: task.id } }
        : { next: { tool: "dsh_get_status", task_id: task.id, wait_seconds: 20 } })
    };
  }

  publicResult(task, { maxChars, includeLogs = false }) {
    const terminal = isTerminal(task);
    if (!terminal) {
      return {
        ok: true,
        task_id: task.id,
        status: task.status,
        terminal: false,
        result: null,
        message: "Task is still running. Call dsh_get_result again with wait_seconds, or use dsh_get_status.",
        next: { tool: "dsh_get_result", task_id: task.id, wait_seconds: 20 }
      };
    }

    const text = task.finalText || "";
    const clipped = clipText(redactSecrets(text), maxChars);
    const tests = extractTestSummary(text);
    const errors = [];
    if (task.error) errors.push({ code: task.error.code, message: task.error.message });
    const stderrErrors = firstMeaningfulError(task.stderrLines);
    if (!task.error && stderrErrors.length > 0 && task.status !== "completed") {
      errors.push(...stderrErrors.map((line) => ({ code: "DSH_STDERR", message: line })));
    }

    const result = {
      text: clipped.text,
      truncated: clipped.truncated,
      tests,
      errors,
      usage: task.usage,
      exit_code: task.exitCode,
      duration_ms: Math.max(0, task.endedAtMs - task.startedMs),
      dsh_session_id: task.dshSessionId
    };

    if (includeLogs) {
      const logExcerpt = task.stderrLines.slice(-20).join("\n");
      result.log_excerpt = clipText(redactSecrets(logExcerpt), 4_000, { keepTail: true }).text;
      result.logs_truncated = task.stderrTruncated || task.stdoutTruncated;
    }

    return {
      ok: true,
      task_id: task.id,
      status: task.status,
      terminal: true,
      result,
      message:
        task.status === "completed"
          ? "DSH completed the task. Review the result and tests before reporting success."
          : `DSH task ended with status ${task.status}. Report the failure honestly.`
    };
  }

  publicList() {
    const tasks = [...this.tasks.values()]
      .sort((a, b) => b.seq - a.seq)
      .map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        terminal: isTerminal(task),
        permission_mode: task.permissionMode,
        workspace: task.workspace,
        created_at: task.createdAt,
        elapsed_ms: Math.max(0, (task.endedAtMs || Date.now()) - task.startedMs)
      }));
    return {
      ok: true,
      count: tasks.length,
      active_count: this.activeCount,
      max_tasks: this.config.limits.maxTasks,
      max_concurrent_tasks: this.config.limits.maxConcurrentTasks,
      tasks
    };
  }

  async cancel(taskId, reason = "user requested cancellation") {
    const task = this.getOrThrow(taskId);
    if (isTerminal(task)) {
      return {
        ok: true,
        task_id: task.id,
        cancelled: false,
        already_terminal: true,
        status: task.status,
        message: "Task already finished; nothing to cancel."
      };
    }

    task.cancelRequested = true;
    task.progress.phase = "cancelling";
    this.logger.info("task_cancel", { task_id: task.id, reason: redactSecrets(String(reason)).slice(0, 200) });
    task.handle?.cancel?.(redactSecrets(String(reason)).slice(0, 200));

    const deadline = Date.now() + 5_000;
    while (!isTerminal(task) && Date.now() < deadline) {
      await delay(100);
    }
    if (!isTerminal(task)) {
      // Fail closed for the client, but keep the exit handler authoritative.
      task.timeoutTriggered = false;
      this.finalize(task, {
        status: "cancelled",
        error: { code: "CANCEL_UNCONFIRMED", message: "Cancellation was requested but process exit was not confirmed." }
      });
    }
    return {
      ok: true,
      task_id: task.id,
      cancelled: true,
      status: task.status,
      message: "Cancellation requested. The DSH process tree was terminated if it was still running."
    };
  }

  async shutdown() {
    const active = [...this.tasks.values()].filter((task) => !isTerminal(task));
    for (const task of active) {
      task.cancelRequested = true;
      task.handle?.cancel?.("MCP server shutting down");
    }
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && active.some((task) => !isTerminal(task))) {
      await delay(100);
    }
  }
}

export function summarizeTaskForLog(task) {
  return safeJsonStringify({
    task_id: task.id,
    status: task.status,
    permission_mode: task.permissionMode,
    elapsed_ms: (task.endedAtMs || Date.now()) - task.startedMs
  });
}
