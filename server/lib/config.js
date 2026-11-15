import { readFileSync, existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeError } from "./errors.js";

export const BRIDGE_NAME = "chatgpt-dsh-bridge";
export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BRIDGE_VERSION = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, "package.json"), "utf8")).version;

const DEFAULTS = Object.freeze({
  dshProfile: "headless",
  maxTasks: 20,
  maxConcurrentTasks: 2,
  maxTaskChars: 12_000,
  maxLogBytes: 1_000_000,
  maxResultChars: 12_000,
  maxErrorChars: 4_000,
  defaultTimeoutSeconds: 600,
  maxTimeoutSeconds: 1_800,
  minTimeoutSeconds: 30,
  healthProbeTimeoutSeconds: 90,
  maxWaitSeconds: 25,
  writeModeEnabled: false
});

function envFirst(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function boolValue(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^(1|true|yes|on)$/i.test(value.trim())) return true;
    if (/^(0|false|no|off)$/i.test(value.trim())) return false;
  }
  return fallback;
}

function intValue(value, fallback, { min = 1, max = 1_000_000 } = {}) {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Math.min(max, Math.max(min, Number.isFinite(parsed) ? Math.trunc(parsed) : fallback));
}

function readJsonConfig(configPath) {
  if (!existsSync(configPath)) return { config: {}, exists: false };
  let raw;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    throw new BridgeError("CONFIG_UNREADABLE", `Unable to read bridge config at ${configPath}: ${error.message}`);
  }
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("root must be a JSON object");
    }
    return { config: parsed, exists: true };
  } catch (error) {
    throw new BridgeError("CONFIG_INVALID_JSON", `Bridge config is not valid JSON (${configPath}): ${error.message}`);
  }
}

function normalizeRootList(value) {
  if (!value) return [];
  const items = Array.isArray(value) ? value : [value];
  const roots = [];
  for (const item of items) {
    if (typeof item !== "string" || !item.trim()) continue;
    for (const part of item.split(path.delimiter)) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      if (!path.isAbsolute(trimmed) || (process.platform === "win32" && !/^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(trimmed))) {
        throw new BridgeError("CONFIG_INVALID_ROOT", "Every allowedRoots entry must be a fully qualified absolute path.");
      }
      const resolved = path.resolve(trimmed);
      if (!roots.includes(resolved)) roots.push(resolved);
    }
  }
  return roots;
}

function defaultDshHome() {
  return path.join(os.homedir(), ".dsh");
}

function defaultBridgeDataDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(base, "ChatGPT-DSH-Bridge");
}

function resolvePathSetting(envNames, configValue, fallback) {
  return path.resolve(envFirst(...envNames) || configValue || fallback);
}

function filePresent(filePath) {
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function getWriteAuthorizerState({ writeModeEnabled, writeAuthorizerKeyFile }) {
  const writeAuthorizerKeyPresent = filePresent(writeAuthorizerKeyFile);
  return { writeAuthorizerKeyPresent, writeReady: writeModeEnabled && writeAuthorizerKeyPresent };
}

export function loadConfig({ configPathOverride = undefined } = {}) {
  const configPath =
    configPathOverride ||
    envFirst("DSH_BRIDGE_CONFIG") ||
    path.join(PLUGIN_ROOT, "bridge.config.json");

  const { config, exists } = readJsonConfig(configPath);
  const dataDir = defaultBridgeDataDir();

  const dshHome = path.resolve(
    envFirst("DSH_HOME") ||
      (typeof config.dshHome === "string" && config.dshHome.trim()) ||
      defaultDshHome()
  );

  const dshCliPathRaw =
    envFirst("DSH_BRIDGE_DSH_CLI", "DSH_CLI_PATH", "DSH_CLI") ||
    (typeof config.dshCliPath === "string" && config.dshCliPath.trim()) ||
    "";

  const allowedRoots = normalizeRootList(
    envFirst("DSH_BRIDGE_ALLOWED_ROOTS") || config.allowedRoots || []
  );

  const writeGrantFile = resolvePathSetting(
    ["DSH_BRIDGE_WRITE_GRANT_FILE"],
    typeof config.writeGrantFile === "string" ? config.writeGrantFile : "",
    path.join(dataDir, "write-grant.json")
  );
  const writeAuthorizerKeyFile = resolvePathSetting(
    ["DSH_BRIDGE_WRITE_KEY_FILE"],
    typeof config.writeAuthorizerKeyFile === "string" ? config.writeAuthorizerKeyFile : "",
    path.join(dataDir, "write-authorizer.key")
  );
  const runtimeStatusFile = resolvePathSetting(
    ["DSH_BRIDGE_RUNTIME_STATUS_FILE"],
    typeof config.runtimeStatusFile === "string" ? config.runtimeStatusFile : "",
    path.join(dataDir, "runtime-status.json")
  );

  const writeModeEnabled = boolValue(config.writeModeEnabled, DEFAULTS.writeModeEnabled);
  const authorizer = getWriteAuthorizerState({ writeModeEnabled, writeAuthorizerKeyFile });

  const warnings = [];
  if (!exists) warnings.push(`No bridge config found at ${configPath}; using auto-detection.`);
  if (allowedRoots.length === 0) warnings.push("No allowedRoots are configured. Health checks work, but tasks cannot start.");
  if (writeModeEnabled && !authorizer.writeAuthorizerKeyPresent) {
    warnings.push(
      "Write mode is enabled in config but the local authorizer key is missing. Run scripts\\approve-write.ps1 to create it and approve a workspace."
    );
  }
  for (const root of allowedRoots) {
    if (!existsSync(root)) warnings.push(`Allowed root does not exist yet: ${root}`);
  }

  const maxTimeoutSeconds = intValue(config.maxTimeoutSeconds, DEFAULTS.maxTimeoutSeconds, {
    min: DEFAULTS.minTimeoutSeconds,
    max: 3_600
  });
  return {
    bridge: {
      name: BRIDGE_NAME,
      version: BRIDGE_VERSION,
      pluginRoot: PLUGIN_ROOT
    },
    configPath,
    configExists: exists,
    dsh: {
      cliPath: dshCliPathRaw,
      profile: String(config.dshProfile || DEFAULTS.dshProfile).trim() || DEFAULTS.dshProfile,
      dshHome,
      executable: typeof config.dshExecutable === "string" ? config.dshExecutable : "",
      cliJs: typeof config.dshCliJs === "string" ? config.dshCliJs : ""
    },
    limits: {
      maxTasks: intValue(config.maxTasks, DEFAULTS.maxTasks, { min: 1, max: 100 }),
      maxConcurrentTasks: intValue(config.maxConcurrentTasks, DEFAULTS.maxConcurrentTasks, { min: 1, max: 8 }),
      maxTaskChars: intValue(config.maxTaskChars, DEFAULTS.maxTaskChars, { min: 1_000, max: 50_000 }),
      maxLogBytes: intValue(config.maxLogBytes, DEFAULTS.maxLogBytes, { min: 64_000, max: 10_000_000 }),
      maxResultChars: intValue(config.maxResultChars, DEFAULTS.maxResultChars, { min: 1_000, max: 50_000 }),
      maxErrorChars: intValue(config.maxErrorChars, DEFAULTS.maxErrorChars, { min: 500, max: 20_000 }),
      defaultTimeoutSeconds: intValue(config.defaultTimeoutSeconds, DEFAULTS.defaultTimeoutSeconds, {
        min: DEFAULTS.minTimeoutSeconds,
        max: maxTimeoutSeconds
      }),
      maxTimeoutSeconds,
      healthProbeTimeoutSeconds: intValue(
        config.healthProbeTimeoutSeconds,
        DEFAULTS.healthProbeTimeoutSeconds,
        { min: 15, max: 300 }
      ),
      maxWaitSeconds: intValue(config.maxWaitSeconds, DEFAULTS.maxWaitSeconds, { min: 0, max: 25 })
    },
    security: {
      allowedRoots,
      writeModeEnabled,
      ...authorizer,
      writeAuthorizerKeyFile,
      writeGrantFile,
      runtimeStatusFile,
      writeAuthorization: "local-grant"
    },
    warnings
  };
}

export function describeConfig(config) {
  return {
    config_path: config.configPath,
    config_exists: config.configExists,
    dsh_profile: config.dsh.profile,
    dsh_cli_path: config.dsh.cliPath || null,
    dsh_home: config.dsh.dshHome,
    allowed_roots: config.security.allowedRoots,
    allowed_roots_count: config.security.allowedRoots.length,
    write_mode_enabled: config.security.writeModeEnabled,
    write_ready: config.security.writeReady,
    write_authorization: config.security.writeAuthorization,
    write_authorizer_key_present: config.security.writeAuthorizerKeyPresent,
    write_grant_file: config.security.writeGrantFile,
    runtime_status_file: config.security.runtimeStatusFile,
    limits: config.limits,
    warnings: config.warnings
  };
}
