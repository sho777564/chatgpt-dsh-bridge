import { redactSecrets, safeJsonStringify } from "./text.js";

function write(level, message, fields) {
  const record = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(fields && typeof fields === "object" ? fields : {})
  };
  let line;
  try {
    line = JSON.stringify(record);
  } catch {
    line = JSON.stringify({ ts: record.ts, level, msg: message });
  }
  // MCP stdio uses stdout exclusively for protocol frames. All logs go to stderr.
  process.stderr.write(`${redactSecrets(line).slice(0, 8_000)}\n`);
}

export function createLogger({ debug = false } = {}) {
  return {
    debug: (message, fields) => {
      if (debug) write("debug", message, fields);
    },
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
    child: (message, fields) => {
      const safe = safeJsonStringify(fields ?? {}, 8_000);
      write("info", message, { detail: safe });
    }
  };
}
