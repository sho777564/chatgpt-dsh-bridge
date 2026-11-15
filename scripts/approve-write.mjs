#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig } from "../server/lib/config.js";
import { validateWorkspace } from "../server/lib/path-policy.js";
import { createWriteGrant } from "../server/lib/write-grant.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function getArg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
    return process.argv[index + 1];
  }
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const configPath =
    getArg("config", process.env.DSH_BRIDGE_CONFIG || path.join(here, "..", "bridge.config.json"));
  const workspaceArg = getArg("workspace");
  const minutes = Number(getArg("minutes", "30"));
  const permanent = hasFlag("permanent");

  if (!workspaceArg) {
    throw new Error("Missing --workspace <absolute path>.");
  }
  if (permanent && hasFlag("yes")) {
    throw new Error(
      "Permanent grants require interactive local confirmation and cannot be created with --yes."
    );
  }

  const config = loadConfig({ configPathOverride: configPath });
  if (!config.security.writeModeEnabled) {
    throw new Error(
      `Write mode is disabled in ${config.configPath}. Set writeModeEnabled=true or run enable-write.ps1 first.`
    );
  }

  const canonicalWorkspace = await realpath(path.resolve(workspaceArg));
  const validatedWorkspace = await validateWorkspace(canonicalWorkspace, config, {
    permissionMode: "workspace-write"
  });

  if (permanent) {
    if (!input.isTTY) {
      throw new Error(
        "Permanent grants require an interactive terminal. Run approve-write.ps1 from a local PowerShell window."
      );
    }
    const rl = createInterface({ input, output });
    output.write("\nPERMANENT workspace-write approval\n");
    output.write(`  workspace: ${validatedWorkspace}\n`);
    output.write("  This grant does not expire. It remains valid until revoked locally.\n");
    const answer = await rl.question("Type PERMANENT to approve locally: ");
    rl.close();
    if (answer.trim() !== "PERMANENT") {
      output.write("Approval cancelled.\n");
      process.exitCode = 2;
      return;
    }
  } else if (!hasFlag("yes")) {
    if (!input.isTTY) {
      throw new Error("Refusing to approve without an interactive terminal. Use -Yes only for an explicit local test.");
    }
    const rl = createInterface({ input, output });
    output.write("\nLocal workspace-write approval\n");
    output.write(`  workspace: ${validatedWorkspace}\n`);
    output.write(`  duration:  ${minutes} minutes\n`);
    const answer = await rl.question("Type YES to approve locally: ");
    rl.close();
    if (answer.trim() !== "YES") {
      output.write("Approval cancelled.\n");
      process.exitCode = 2;
      return;
    }
  }

  const grant = await createWriteGrant(config, {
    workspace: validatedWorkspace,
    minutes,
    permanent
  });

  output.write(`${JSON.stringify({ ok: true, ...grant, config_path: config.configPath }, null, 2)}\n`);
  output.write(
    permanent
      ? "No token was printed or sent to the model. This permanent grant is scoped to this exact directory identity and can be revoked immediately.\n"
      : "No token was printed or sent to the model. The grant is scoped to this workspace and expires automatically.\n"
  );
}

main().catch((error) => {
  process.stderr.write(`${error?.code ? `${error.code}: ` : ""}${error?.message || String(error)}\n`);
  process.exitCode = 1;
});
