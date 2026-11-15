#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../server/lib/config.js";
import { revokeWriteGrant } from "../server/lib/write-grant.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const configPath =
  process.env.DSH_BRIDGE_CONFIG || path.join(here, "..", "bridge.config.json");

try {
  const config = loadConfig({ configPathOverride: configPath });
  const result = await revokeWriteGrant(config);
  process.stdout.write(
    `${JSON.stringify({ ok: true, ...result, config_path: config.configPath }, null, 2)}\n`
  );
} catch (error) {
  process.stderr.write(`${error?.code ? `${error.code}: ` : ""}${error?.message || String(error)}\n`);
  process.exitCode = 1;
}
