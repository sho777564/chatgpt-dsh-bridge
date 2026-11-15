import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, extractTestSummary, clipText, firstMeaningfulError } from "../../server/lib/text.js";

test("redactSecrets removes common token shapes", () => {
  const text = [
    "api_key=sk-abcdefghijklmnop",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    "password: hunter2secret",
    "github_pat_11ABCDEFG0123456789_abcdefghijklmnop"
  ].join("\n");
  const redacted = redactSecrets(text);
  assert.doesNotMatch(redacted, /sk-abcdefghijklmnop/);
  assert.doesNotMatch(redacted, /abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(redacted, /hunter2secret/);
  assert.doesNotMatch(redacted, /github_pat_11ABCDEFG/);
  assert.match(redacted, /\[REDACTED\]/);
});

test("extractTestSummary keeps only bounded test-like lines", () => {
  const text = [
    "Implemented the feature.",
    "PASS  test/unit/foo.test.js",
    "FAIL  test/unit/bar.test.js",
    "Tests: 8 passed, 1 failed",
    "This paragraph mentions a test but is not a result line and is also quite long ".repeat(3)
  ].join("\n");
  const summary = extractTestSummary(text);
  assert.ok(summary.length >= 3);
  assert.ok(summary.some((line) => line.includes("PASS")));
  assert.ok(summary.some((line) => line.includes("Tests:")));
});

test("clipText preserves the requested end and reports truncation", () => {
  const result = clipText("a".repeat(50), 10, { keepTail: true });
  assert.equal(result.truncated, true);
  assert.equal(result.originalChars, 50);
  assert.match(result.text, /truncated 40 chars/);
  assert.ok(result.text.endsWith("a".repeat(10)));
});

test("firstMeaningfulError returns only error-like lines", () => {
  const lines = ["starting", "all good", "Error: EACCES permission denied", "done"];
  assert.deepEqual(firstMeaningfulError(lines), ["Error: EACCES permission denied"]);
});
