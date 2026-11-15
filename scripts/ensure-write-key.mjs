#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../server/lib/config.js";
import { ensureWriteAuthorizerKey } from "../server/lib/write-grant.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const configPath =
  process.env.DSH_BRIDGE_CONFIG || path.join(here, "..", "bridge.config.json");

try {
  const config = loadConfig({ configPathOverride: configPath });
  if (!config.security.writeModeEnabled) {
    throw new Error("writeModeEnabled is false in the bridge config.");
  }
  const result = await ensureWriteAuthorizerKey(config);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        key_created: result.created,
        key_path: result.path,
        key_bytes: result.bytes,
        config_path: config.configPath
      },
      null,
      2
    )}\n`
  );
} catch (error) {
  process.stderr.write(`${error?.code ? `${error.code}: ` : ""}${error?.message || String(error)}\n`);
  process.exitCode = 1;
}
