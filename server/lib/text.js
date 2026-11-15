const ANSI_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;

/**
 * Redact common secret shapes before text can reach a model, an error result,
 * or the bridge log. This is defense in depth, not a substitute for never
 * collecting secrets in the first place.
 */
export function redactSecrets(input) {
  let text = String(input ?? "");
  text = text.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[REDACTED]");
  text = text.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, "$1 [REDACTED]");
  text = text.replace(
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret|write[_-]?token)\b(\s*[:=]\s*)(["']?)[^\s"',;]{4,}\3/gi,
    "$1$2[REDACTED]"
  );
  text = text.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "gh[REDACTED]");
  text = text.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "github_pat_[REDACTED]");
  text = text.replace(/\bAKIA[0-9A-Z]{16}\b/g, "AKIA[REDACTED]");
  return text;
}

export function stripAnsi(input) {
  return String(input ?? "").replace(ANSI_ESCAPE, "");
}

export function clipText(input, maxChars, { keepTail = false } = {}) {
  const text = String(input ?? "");
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) {
    return { text, truncated: false, originalChars: text.length };
  }
  if (keepTail) {
    return {
      text: `…[truncated ${text.length - maxChars} chars]…\n${text.slice(-maxChars)}`,
      truncated: true,
      originalChars: text.length
    };
  }
  return {
    text: `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars]…`,
    truncated: true,
    originalChars: text.length
  };
}

export function normalizeNewlines(input) {
  return String(input ?? "").replace(/\r\n?/g, "\n");
}

const TEST_LINE_PATTERN =
  /(?:^|\s)(?:PASS|FAIL|PASSED|FAILED|OK|ERROR|✓|✗|×|Tests?:|Test Suites?:|Test Files?:|Passed!|Failed!|passed|failed)\b|(?:npm (?:run )?test|pnpm test|yarn test|vitest|jest|pytest|go test|cargo test|dotnet test|ctest|mocha)\b/i;

/**
 * Extract a small, bounded test/verification summary from the final answer.
 * DSH is an agent, so this is a heuristic summary, not a machine-verified test
 * report. The full final text remains available separately.
 */
export function extractTestSummary(input, maxLines = 20) {
  const lines = normalizeNewlines(input)
    .split("\n")
    .map((line) => stripAnsi(line).trim())
    .filter((line) => line.length > 0 && line.length <= 500)
    .filter((line) => TEST_LINE_PATTERN.test(line));

  const unique = [];
  const seen = new Set();
  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);
    unique.push(line);
    if (unique.length >= maxLines) break;
  }
  return unique;
}

export function firstMeaningfulError(lines, maxLines = 5) {
  const cleaned = lines
    .map((line) => stripAnsi(line).trim())
    .filter(Boolean)
    .filter((line) => /\b(error|failed|exception|denied|timed out|timeout|not found|ENOENT|EACCES|EPERM)\b/i.test(line));

  return cleaned.slice(-maxLines).map((line) => clipText(redactSecrets(line), 500).text);
}

export function safeJsonStringify(value, maxChars = 12_000) {
  let text;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = JSON.stringify({ ok: false, error: { code: "SERIALIZATION_ERROR", message: "Result was not JSON serializable." } });
  }
  return clipText(text, maxChars).text;
}
