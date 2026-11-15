import { realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BridgeError } from "./errors.js";

const WINDOWS = process.platform === "win32";

function normalizeForCompare(value) {
  const resolved = path.resolve(value);
  return WINDOWS ? resolved.toLowerCase() : resolved;
}

/** True when `child` is `parent` itself or a descendant of `parent`. */
export function isSameOrInside(parent, child) {
  const relative = path.relative(normalizeForCompare(parent), normalizeForCompare(child));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertNotSensitiveDirectory(resolved, config) {
  const home = path.resolve(os.homedir());
  const parsed = path.parse(resolved);
  if (normalizeForCompare(parsed.root) === normalizeForCompare(resolved)) {
    throw new BridgeError("WORKSPACE_TOO_BROAD", "A drive root cannot be used as a workspace.");
  }

  const forbiddenTrees = [
    [path.join(home, ".ssh"), "~/.ssh"],
    [path.join(home, ".aws"), "~/.aws"],
    [path.join(home, ".azure"), "~/.azure"],
    [path.join(home, ".gnupg"), "~/.gnupg"],
    [path.join(home, ".kube"), "~/.kube"],
    [path.join(home, ".config"), "~/.config"],
    [path.join(home, ".dsh"), "the DSH configuration directory"],
    [config.dsh.dshHome, "the DSH configuration directory"],
    [path.join(home, ".codex"), "the Codex configuration directory"],
    [config.bridge.pluginRoot, "the bridge's own plugin directory"],
    [config.security.writeAuthorizerKeyFile, "the local write authorizer key"],
    [config.security.writeGrantFile, "the local write grant"]
  ];
  if (WINDOWS) {
    forbiddenTrees.push(
      [process.env.SystemRoot || "C:\\Windows", "Windows"],
      [process.env.ProgramFiles || "C:\\Program Files", "Program Files"],
      [process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Program Files"],
      [path.join(home, "AppData"), "AppData"]
    );
  }
  for (const [root, label] of forbiddenTrees) {
    if (root && (isSameOrInside(root, resolved) || isSameOrInside(resolved, root))) {
      throw new BridgeError("WORKSPACE_SENSITIVE", `The workspace cannot overlap ${label}.`);
    }
  }
}

export async function validateWorkspace(rawWorkspace, config) {
  if (typeof rawWorkspace !== "string" || !rawWorkspace.trim()) {
    throw new BridgeError("WORKSPACE_INVALID", "workspace must be a non-empty absolute path.");
  }
  if (rawWorkspace.includes("\0")) {
    throw new BridgeError("WORKSPACE_INVALID", "workspace contains an invalid NUL character.");
  }
  if (!path.isAbsolute(rawWorkspace) || (WINDOWS && !/^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(rawWorkspace))) {
    throw new BridgeError("WORKSPACE_INVALID", "workspace must be an absolute path (for example G:\\projects\\my-app).");
  }

  let resolved;
  try {
    resolved = await realpath(rawWorkspace);
  } catch {
    throw new BridgeError("WORKSPACE_NOT_FOUND", `Workspace does not exist or is not accessible: ${rawWorkspace}`);
  }

  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new BridgeError("WORKSPACE_NOT_FOUND", `Workspace cannot be inspected: ${resolved}`);
  }
  if (!info.isDirectory()) {
    throw new BridgeError("WORKSPACE_NOT_DIRECTORY", `Workspace is not a directory: ${resolved}`);
  }

  assertNotSensitiveDirectory(resolved, config);

  if (!config.security.allowedRoots.length) {
    throw new BridgeError("WORKSPACE_ROOTS_REQUIRED", "Configure at least one project directory in allowedRoots, then restart the bridge.");
  }
  const allowed = await Promise.all(config.security.allowedRoots.map((root) => realpath(root).catch(() => null)));
  if (!allowed.some((root) => root && isSameOrInside(root, resolved))) {
    throw new BridgeError("WORKSPACE_OUTSIDE_ALLOWED_ROOTS", "Workspace is outside allowedRoots configured for this bridge.");
  }

  return resolved;
}

export function assertSafeWorkspaceSync(resolved, config) {
  assertNotSensitiveDirectory(resolved, config);
  return resolved;
}
