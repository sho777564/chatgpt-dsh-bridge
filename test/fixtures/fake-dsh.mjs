const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("0.0.0-fixture");
  process.exit(0);
}
if (args.includes("--dump-config")) {
  console.log("bundle: dsh-headless\nprovider: deepseek-account\nmodel: fixture");
  process.exit(0);
}
const mode = args.includes("--json") ? "complete" : args[0] || "complete";
const delayMs = Number(process.argv[3] || 50);
const fixture = process.argv[4] || "fixture";

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  process.stdout.write(
    JSON.stringify({ type: "session", sessionId: `session-${fixture}`, cwd: process.cwd() }) + "\n"
  );
  process.stdout.write(
    JSON.stringify({ type: "status", phase: "turn_start", turn: 1 }) + "\n"
  );

  if (mode === "hang") {
    setInterval(() => {}, 1_000);
    return;
  }

  setTimeout(() => {
    if (mode === "fail") {
      process.stderr.write("Error: simulated DSH failure\n");
      process.exitCode = 2;
      return;
    }
    if (mode === "no-final") {
      process.exitCode = 0;
      return;
    }
    process.stdout.write(
      JSON.stringify({
        type: "status",
        phase: "step_end",
        turn: 1,
        step: 1,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
      }) + "\n"
    );
    process.stdout.write(
      JSON.stringify({
        type: "final",
        sessionId: `session-${fixture}`,
        reason: { kind: "completed" },
        text: [
          "PASS fixture test",
          "DSH_BRIDGE_FIXTURE_OK",
          ...(prompt.match(/\b(?:DSH_BRIDGE_INTEGRATION_OK|PERMANENT_GRANT_OK|DSH_BRIDGE_OK)\b/g) ?? [])
        ].join("\n")
      }) + "\n"
    );
    process.exitCode = 0;
  }, delayMs);
});
