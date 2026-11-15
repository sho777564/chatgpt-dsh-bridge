import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { BridgeError } from "./errors.js";

const GRANT_VERSION = 2;
const GRANT_SCOPE = "workspace-write";
const MIN_KEY_BYTES = 32;
const MAX_GRANT_MINUTES = 240;
const KIND_TIMED = "timed";
const KIND_PERMANENT = "permanent";

function normalizeWorkspace(workspace) {
  const resolved = path.resolve(String(workspace || ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInside(parent, child) {
  const relative = path.relative(normalizeWorkspace(parent), normalizeWorkspace(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertAuthStorageSafe(config, filePath, label) {
  const pluginRoot = config?.bridge?.pluginRoot;
  if (pluginRoot && isInside(pluginRoot, filePath)) {
    throw new BridgeError(
      "WRITE_AUTH_PATH_UNSAFE",
      `${label} must not be stored inside the Bridge source/plugin directory.`
    );
  }
}

function keyBytesFromText(text) {
  const value = String(text || "").trim();
  if (!value) throw new BridgeError("WRITE_KEY_INVALID", "The local write authorizer key is empty.");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length < MIN_KEY_BYTES) {
    throw new BridgeError("WRITE_KEY_INVALID", "The local write authorizer key is too short.");
  }
  return bytes;
}

async function readAuthorizerKey(config) {
  const keyPath = config.security.writeAuthorizerKeyFile;
  assertAuthStorageSafe(config, keyPath, "The write authorizer key");
  if (!existsSync(keyPath)) {
    throw new BridgeError(
      "WRITE_AUTHORIZER_KEY_MISSING",
      "The local write authorizer key does not exist. Run scripts\\approve-write.ps1 to create it and approve a workspace."
    );
  }
  try {
    return keyBytesFromText(await readFile(keyPath, "utf8"));
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError("WRITE_KEY_UNREADABLE", "The local write authorizer key could not be read.");
  }
}

export async function ensureWriteAuthorizerKey(config) {
  const keyPath = config.security.writeAuthorizerKeyFile;
  assertAuthStorageSafe(config, keyPath, "The write authorizer key");
  await mkdir(path.dirname(keyPath), { recursive: true });
  if (existsSync(keyPath)) {
    const existing = await readAuthorizerKey(config);
    return { path: keyPath, created: false, bytes: existing.length };
  }

  const key = randomBytes(MIN_KEY_BYTES).toString("base64url");
  try {
    await writeFile(keyPath, key, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw new BridgeError("WRITE_KEY_CREATE_FAILED", "The local write authorizer key could not be created.");
    }
  }
  const bytes = await readAuthorizerKey(config);
  return { path: keyPath, created: true, bytes: bytes.length };
}

function signPayload(payload, key) {
  return createHmac("sha256", key).update(JSON.stringify(payload)).digest("base64url");
}

function publicPayload(payload) {
  const permanent = payload.kind === KIND_PERMANENT;
  return {
    version: payload.version,
    scope: payload.scope,
    kind: permanent ? KIND_PERMANENT : KIND_TIMED,
    permanent,
    workspace: payload.workspace,
    issued_at: payload.issued_at,
    expires_at: permanent ? null : payload.expires_at,
    grant_id: payload.grant_id
  };
}

async function writeGrantFileAtomic(filePath, grant) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(grant, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temp, filePath);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function directoryIdentity(workspace) {
  let canonical;
  try {
    canonical = await realpath(path.resolve(String(workspace || "")));
  } catch {
    throw new BridgeError("WORKSPACE_NOT_FOUND", "The approved workspace does not exist or cannot be resolved.");
  }
  let info;
  try {
    info = await stat(canonical, { bigint: true });
  } catch {
    throw new BridgeError("WORKSPACE_NOT_FOUND", "The approved workspace cannot be inspected.");
  }
  if (!info.isDirectory()) {
    throw new BridgeError("WORKSPACE_NOT_DIRECTORY", "The approved workspace is not a directory.");
  }
  return {
    workspace: canonical,
    directory: { dev: String(info.dev), ino: String(info.ino) }
  };
}

export async function createWriteGrant(
  config,
  { workspace, minutes = 30, now = Date.now(), permanent = false }
) {
  if (!config.security.writeModeEnabled) {
    throw new BridgeError(
      "WRITE_MODE_DISABLED",
      "workspace-write is disabled in bridge.config.json. Set writeModeEnabled=true first."
    );
  }
  if (!path.isAbsolute(String(workspace || ""))) {
    throw new BridgeError("WORKSPACE_INVALID", "The approved workspace must be an absolute path.");
  }

  let duration = null;
  if (!permanent) {
    duration = Number(minutes);
    if (!Number.isFinite(duration) || duration < 1 || duration > MAX_GRANT_MINUTES) {
      throw new BridgeError("WRITE_GRANT_DURATION_INVALID", `Grant minutes must be between 1 and ${MAX_GRANT_MINUTES}.`);
    }
  }

  const identity = await directoryIdentity(workspace);
  assertAuthStorageSafe(config, config.security.writeGrantFile, "The write grant");
  await ensureWriteAuthorizerKey(config);
  const key = await readAuthorizerKey(config);
  const issuedAt = new Date(now);
  const expiresAt = permanent ? null : new Date(now + Math.trunc(duration) * 60_000);
  const payload = {
    version: GRANT_VERSION,
    scope: GRANT_SCOPE,
    kind: permanent ? KIND_PERMANENT : KIND_TIMED,
    workspace: identity.workspace,
    directory: identity.directory,
    issued_at: issuedAt.toISOString(),
    expires_at: expiresAt ? expiresAt.toISOString() : null,
    grant_id: randomUUID(),
    nonce: randomBytes(16).toString("base64url")
  };
  const grant = { payload, signature: signPayload(payload, key) };
  await writeGrantFileAtomic(config.security.writeGrantFile, grant);
  return {
    ...publicPayload(payload),
    grant_file: config.security.writeGrantFile,
    valid_for_minutes: permanent ? null : Math.trunc(duration)
  };
}

async function readGrantFile(config) {
  const grantPath = config.security.writeGrantFile;
  if (!existsSync(grantPath)) {
    return { present: false, grant: null, reason: "missing" };
  }
  try {
    const raw = await readFile(grantPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed?.payload || typeof parsed.payload !== "object" || typeof parsed.signature !== "string") {
      return { present: true, grant: null, reason: "invalid-json-shape" };
    }
    return { present: true, grant: parsed, reason: null };
  } catch {
    return { present: true, grant: null, reason: "unreadable-or-invalid-json" };
  }
}

function safeSignatureEqual(expected, actualText) {
  try {
    const actual = Buffer.from(String(actualText || ""), "base64url");
    const expectedBuffer = Buffer.from(String(expected || ""), "base64url");
    return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
  } catch {
    return false;
  }
}

function grantKind(payload) {
  if (payload.kind === KIND_PERMANENT) return KIND_PERMANENT;
  if (payload.kind === KIND_TIMED) return KIND_TIMED;
  return null;
}

async function verifyDirectoryIdentity(payload) {
  let canonical;
  try {
    canonical = await realpath(payload.workspace);
  } catch {
    return "workspace-unavailable";
  }
  if (normalizeWorkspace(canonical) !== normalizeWorkspace(payload.workspace)) {
    return "workspace-path-changed";
  }
  let info;
  try {
    info = await stat(canonical, { bigint: true });
  } catch {
    return "workspace-unavailable";
  }
  if (!info.isDirectory()) return "workspace-not-directory";
  if (
    !payload.directory ||
    String(info.dev) !== String(payload.directory.dev) ||
    String(info.ino) !== String(payload.directory.ino)
  ) {
    return "directory-identity-mismatch";
  }
  return null;
}

export async function verifyWriteGrant(config, { workspace = null, now = Date.now() } = {}) {
  const base = {
    present: false,
    valid: false,
    expired: false,
    kind: null,
    permanent: false,
    reason: "missing",
    grant_id: null,
    workspace: null,
    expires_at: null,
    issued_at: null
  };

  const file = await readGrantFile(config);
  if (!file.present) return base;
  if (!file.grant) return { ...base, present: true, reason: file.reason || "invalid-grant" };

  const payload = file.grant.payload;
  const kind = grantKind(payload);
  const summary = {
    ...base,
    present: true,
    kind,
    permanent: kind === KIND_PERMANENT,
    grant_id: typeof payload.grant_id === "string" ? payload.grant_id : null,
    workspace: typeof payload.workspace === "string" ? payload.workspace : null,
    expires_at: typeof payload.expires_at === "string" ? payload.expires_at : null,
    issued_at: typeof payload.issued_at === "string" ? payload.issued_at : null
  };

  if (payload.version !== GRANT_VERSION) {
    return { ...summary, reason: "wrong-version" };
  }
  if (payload.scope !== GRANT_SCOPE || !kind) {
    return { ...summary, reason: "wrong-scope-or-kind" };
  }
  if (typeof payload.workspace !== "string" || !path.isAbsolute(payload.workspace)) {
    return { ...summary, reason: "invalid-workspace" };
  }
  if (kind === KIND_PERMANENT && payload.expires_at !== null) {
    return { ...summary, reason: "invalid-permanent-expiry" };
  }
  if (kind === KIND_TIMED && typeof payload.expires_at !== "string") {
    return { ...summary, reason: "invalid-expiry" };
  }

  let key;
  try {
    key = await readAuthorizerKey(config);
  } catch (error) {
    return {
      ...summary,
      reason:
        error.code === "WRITE_AUTHORIZER_KEY_MISSING"
          ? "authorizer-key-missing"
          : "authorizer-key-unreadable"
    };
  }

  const expected = signPayload(payload, key);
  if (!safeSignatureEqual(expected, file.grant.signature)) {
    return { ...summary, reason: "signature-invalid" };
  }

  if (kind === KIND_TIMED) {
    const expiresMs = Date.parse(payload.expires_at);
    if (!Number.isFinite(expiresMs)) return { ...summary, reason: "invalid-expiry" };
    if (expiresMs <= now) {
      return { ...summary, valid: false, expired: true, reason: "expired" };
    }
  }

  if (workspace !== null && normalizeWorkspace(payload.workspace) !== normalizeWorkspace(workspace)) {
    return { ...summary, reason: "workspace-mismatch" };
  }

  const identityFailure = await verifyDirectoryIdentity(payload);
  if (identityFailure) return { ...summary, reason: identityFailure };

  return { ...summary, valid: true, expired: false, reason: "valid" };
}

export async function getWriteGrantStatus(config) {
  return verifyWriteGrant(config);
}

export async function revokeWriteGrant(config) {
  const grantPath = config.security.writeGrantFile;
  if (!existsSync(grantPath)) return { revoked: false, grant_file: grantPath };
  await rm(grantPath, { force: true });
  return { revoked: true, grant_file: grantPath };
}

export function writeApprovalCommand(config, workspace) {
  const safeWorkspace = String(workspace || "<absolute-workspace>");
  const script = path.join(config.bridge.pluginRoot, "scripts", "approve-write.ps1");
  return `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" -Workspace "${safeWorkspace}" -Minutes 30`;
}

export function permanentApprovalCommand(config, workspace) {
  const safeWorkspace = String(workspace || "<absolute-workspace>");
  const script = path.join(config.bridge.pluginRoot, "scripts", "approve-write.ps1");
  return `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" -Workspace "${safeWorkspace}" -Permanent`;
}
