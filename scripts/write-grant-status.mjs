#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../server/lib/config.js";
import { getWriteGrantStatus } from "../server/lib/write-grant.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const configPath =
  process.env.DSH_BRIDGE_CONFIG || path.join(here, "..", "bridge.config.json");

try {
  const config = loadConfig({ configPathOverride: configPath });
  const grant = config.security.writeModeEnabled
    ? await getWriteGrantStatus(config)
    : {
        present: false,
        valid: false,
        expired: false,
        kind: null,
        permanent: false,
        reason: "write-mode-disabled",
        grant_id: null,
        workspace: null,
        expires_at: null
      };
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        config_path: config.configPath,
        write_mode_enabled: config.security.writeModeEnabled,
        write_ready: config.security.writeReady,
        write_authorization: config.security.writeAuthorization,
        write_grant: {
          present: grant.present,
          valid: grant.valid,
          expired: grant.expired,
          kind: grant.kind,
          permanent: grant.permanent === true,
          reason: grant.reason,
          grant_id: grant.grant_id,
          workspace: grant.workspace,
          expires_at: grant.expires_at
        }
      },
      null,
      2
    )}\n`
  );
} catch (error) {
  process.stderr.write(`${error?.code ? `${error.code}: ` : ""}${error?.message || String(error)}\n`);
  process.exitCode = 1;
}
