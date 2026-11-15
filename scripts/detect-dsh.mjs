import { readFileSync, existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");

export function detectDshCli() {
  const env = process.env.DSH_BRIDGE_DSH_CLI || process.env.DSH_CLI_PATH || process.env.DSH_CLI;
  if (env && existsSync(env)) return path.resolve(env);

  const candidates = [
    path.join(process.env.LOCALAPPDATA || "", "Programs", "DeepSeek Harness", "resources", "runtime", "cli", "bin", "dsh.cmd"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "DeepSeek Harness", "resources", "runtime", "cli", "bin", "dsh.cmd")
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return path.resolve(candidate);
  }

  const configPath = process.env.DSH_BRIDGE_CONFIG || path.join(pluginRoot, "bridge.config.json");
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      if (typeof config.dshCliPath === "string" && existsSync(config.dshCliPath)) {
        return path.resolve(config.dshCliPath);
      }
    } catch {
      // Report a useful result through the return value.
    }
  }
  return null;
}

export function resolveNodeExecutable() {
  try {
    return realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}

export { pluginRoot };
export const serverEntry = path.join(pluginRoot, "server", "index.js");
