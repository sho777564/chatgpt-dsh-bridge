import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BridgeError } from "./errors.js";

function existingFile(candidate) {
  if (!candidate || typeof candidate !== "string") return null;
  try {
    const resolved = path.resolve(candidate);
    return existsSync(resolved) && statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

function systemPowerShell() {
  return path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
}

function powerShellRegistryDiscovery() {
  if (process.platform !== "win32") return [];
  try {
    const script =
      "$ErrorActionPreference='SilentlyContinue';" +
      "@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
      "'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
      "'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*') | " +
      "ForEach-Object { Get-ItemProperty $_ } | " +
      "Where-Object { $_.DisplayName -like '*DeepSeek Harness*' -and $_.InstallLocation } | " +
      "Select-Object -ExpandProperty InstallLocation -Unique";
    const output = execFileSync(
      systemPowerShell(),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", timeout: 8_000, windowsHide: true }
    );
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function runningDesktopDiscovery() {
  if (process.platform !== "win32") return [];
  try {
    const output = execFileSync(
      systemPowerShell(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path"
      ],
      { encoding: "utf8", timeout: 8_000, windowsHide: true }
    ).trim();
    if (!output) return [];
    // ...\app\DeepSeek Harness.exe -> ...\app
    return [path.dirname(output)];
  } catch {
    return [];
  }
}

function cliFromAppRoot(appRoot) {
  return existingFile(path.join(appRoot, "resources", "runtime", "cli", "bin", "dsh.cmd"));
}

export function discoverDshCliPath(config) {
  const explicit = existingFile(config?.dsh?.cliPath);
  if (explicit) return explicit;

  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";

  const candidates = [
    path.join(localAppData, "Programs", "DeepSeek Harness", "resources", "runtime", "cli", "bin", "dsh.cmd"),
    path.join(programFiles, "DeepSeek Harness", "resources", "runtime", "cli", "bin", "dsh.cmd"),
    path.join(programFilesX86, "DeepSeek Harness", "resources", "runtime", "cli", "bin", "dsh.cmd"),
    path.join(home, "AppData", "Local", "Programs", "DeepSeek Harness", "resources", "runtime", "cli", "bin", "dsh.cmd")
  ];

  for (const candidate of candidates) {
    const found = existingFile(candidate);
    if (found) return found;
  }

  for (const installLocation of runningDesktopDiscovery()) {
    const found = cliFromAppRoot(installLocation);
    if (found) return found;
  }

  for (const installLocation of powerShellRegistryDiscovery()) {
    const found = cliFromAppRoot(installLocation);
    if (found) return found;
  }

  const pathResolved = existingFile(process.env.DSH_CLI || "");
  if (pathResolved) return pathResolved;

  throw new BridgeError(
    "DSH_NOT_FOUND",
    "DeepSeek Harness CLI was not found. Set dshCliPath in bridge.config.json or the DSH_BRIDGE_DSH_CLI environment variable."
  );
}

/**
 * The DSH desktop ships a dsh.cmd shim that runs its Electron binary with
 * ELECTRON_RUN_AS_NODE and a script inside app.asar. Calling that shim from
 * Node with shell:false is not reliable on Windows, so start the same binary
 * directly with an argument array. No task text ever enters the command line.
 */
export function buildLaunchSpec(config) {
  // An explicit pair is needed when the installation layout is non-standard.
  if (config?.dsh?.executable && config?.dsh?.cliJs) {
    const exe = existingFile(config.dsh.executable);
    if (!exe) {
      throw new BridgeError(
        "DSH_EXECUTABLE_NOT_FOUND",
        "dshExecutable does not point to an existing DeepSeek Harness executable."
      );
    }
    // cli.js normally lives inside app.asar, which ordinary fs.existsSync
    // cannot inspect. Electron can load it; do not reject it here.
    return {
      kind: "electron",
      command: exe,
      prefixArgs: ["--expose-internals", path.resolve(config.dsh.cliJs)],
      cliPath: existingFile(config.dsh.cliPath) || exe,
      appRoot: path.dirname(exe)
    };
  }

  const cliPath = discoverDshCliPath(config);
  if (!cliPath) {
    throw new BridgeError("DSH_NOT_FOUND", "The configured DSH CLI does not exist.");
  }

  const lower = cliPath.toLowerCase();
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    const appRoot = path.resolve(path.dirname(cliPath), "..", "..", "..", "..");
    const exe = existingFile(path.join(appRoot, "DeepSeek Harness.exe"));
    const cliJs = path.join(
      appRoot,
      "resources",
      "app.asar",
      "dsh",
      "node_modules",
      "@deepseek-ai",
      "dsh-desktop-host",
      "lib",
      "cli.js"
    );
    if (!exe) {
      throw new BridgeError(
        "DSH_LAUNCH_UNSUPPORTED",
        "Found dsh.cmd but could not derive the DeepSeek Harness Electron executable. Set dshExecutable and dshCliJs in bridge.config.json."
      );
    }
    return {
      kind: "electron",
      command: exe,
      prefixArgs: ["--expose-internals", cliJs],
      cliPath,
      appRoot
    };
  }

  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return {
      kind: "node",
      command: process.execPath,
      prefixArgs: [cliPath],
      cliPath,
      appRoot: path.dirname(cliPath)
    };
  }

  if (lower.endsWith(".exe")) {
    return {
      kind: "exe",
      command: cliPath,
      prefixArgs: [],
      cliPath,
      appRoot: path.dirname(cliPath)
    };
  }

  throw new BridgeError(
    "DSH_LAUNCH_UNSUPPORTED",
    `Unsupported DSH CLI path type: ${path.basename(cliPath)}. Set dshExecutable and dshCliJs in bridge.config.json.`
  );
}
