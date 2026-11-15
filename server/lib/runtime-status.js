import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getWriteGrantStatus } from "./write-grant.js";

/**
 * Write a secret-free snapshot of the running MCP server. This lets an operator
 * prove which config file a tunnel-launched child actually loaded.
 */
export async function writeRuntimeStatus(config, { transport = "stdio" } = {}) {
  const file = config.security.runtimeStatusFile;
  let grant = null;
  if (config.security.writeModeEnabled) {
    try {
      grant = await getWriteGrantStatus(config);
    } catch {
      grant = { present: false, valid: false, reason: "grant-read-failed" };
    }
  } else {
    grant = { present: false, valid: false, reason: "write-mode-disabled" };
  }

  const payload = {
    pid: process.pid,
    bridge_name: config.bridge.name,
    bridge_version: config.bridge.version,
    plugin_root: config.bridge.pluginRoot,
    started_at: new Date().toISOString(),
    transport,
    config_path: config.configPath,
    config_exists: config.configExists,
    dsh_profile: config.dsh.profile,
    write_mode_enabled: config.security.writeModeEnabled,
    write_ready: config.security.writeReady,
    write_authorization: config.security.writeAuthorization,
    write_authorizer_key_present: config.security.writeAuthorizerKeyPresent,
    allowed_roots: config.security.allowedRoots,
    write_grant: grant
      ? {
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
      : null
  };

  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "w" });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  return payload;
}
