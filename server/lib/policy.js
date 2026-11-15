import { BridgeError } from "./errors.js";
import { getWriteAuthorizerState } from "./config.js";
import {
  verifyWriteGrant,
  writeApprovalCommand,
  permanentApprovalCommand
} from "./write-grant.js";

export const PERMISSION_MODES = ["read-only", "workspace-write"];

export function assertPermissionMode(mode) {
  if (!PERMISSION_MODES.includes(mode)) {
    throw new BridgeError(
      "PERMISSION_MODE_INVALID",
      `permission_mode must be one of: ${PERMISSION_MODES.join(", ")}. danger-full-access is intentionally not supported.`
    );
  }
}

function approvalError(config, workspace, grant) {
  const timedCommand = writeApprovalCommand(config, workspace);
  const permanentCommand = permanentApprovalCommand(config, workspace);
  const reason = grant?.reason || "missing";
  const detail =
    reason === "expired"
      ? "The last local write grant has expired."
      : reason === "workspace-mismatch"
        ? "The local write grant is for a different workspace."
        : reason === "directory-identity-mismatch" || reason === "workspace-path-changed"
          ? "The local write grant no longer matches this directory's identity (it may have been replaced or linked elsewhere)."
          : "No valid local write grant exists for this workspace.";
  return new BridgeError(
    "WRITE_LOCAL_APPROVAL_REQUIRED",
    `${detail} The user must approve locally, then retry. Timed approval: ${timedCommand}. Permanent approval (interactive local terminal only): ${permanentCommand}. No write token is sent to the model.`,
    {
      reason,
      required_workspace: workspace,
      grant_workspace: grant?.workspace || null,
      grant_expires_at: grant?.expires_at || null
    }
  );
}

/**
 * Write authorization is intentionally local-first:
 *   1. write mode must be enabled in bridge.config.json;
 *   2. the model must set allow_write=true (a signal, not proof of consent);
 *   3. an HMAC-signed grant for this exact workspace must exist,
 *      created by scripts/approve-write.ps1 on the user's machine.
 *
 * There is deliberately no write token in the tool schema. The model never
 * sees the authorizer key or grant signature.
 */
export async function authorizeWorkspaceWrite(config, { permissionMode, allowWrite, workspace }) {
  if (permissionMode !== "workspace-write") {
    return { required: false, authorization: null };
  }

  if (!config.security.writeModeEnabled) {
    throw new BridgeError(
      "WRITE_MODE_DISABLED",
      "workspace-write is disabled in bridge.config.json. The user must enable it locally before any write task can start."
    );
  }

  if (allowWrite !== true) {
    throw new BridgeError(
      "WRITE_APPROVAL_REQUIRED",
      "workspace-write requires allow_write=true, and a valid local write grant for this exact workspace."
    );
  }

  if (!getWriteAuthorizerState(config.security).writeReady) {
    throw new BridgeError(
      "WRITE_AUTHORIZER_NOT_READY",
      `The local write authorizer key is missing. Ask the user to run: ${writeApprovalCommand(config, workspace)}. No token is sent to the model.`
    );
  }

  let grant;
  try {
    grant = await verifyWriteGrant(config, { workspace });
  } catch {
    throw approvalError(config, workspace, { reason: "grant-unreadable" });
  }

  if (!grant.valid) {
    throw approvalError(config, workspace, grant);
  }

  return {
    required: true,
    authorization: "local-grant",
    kind: grant.kind,
    permanent: grant.permanent === true,
    grant_id: grant.grant_id,
    expires_at: grant.expires_at,
    workspace: grant.workspace
  };
}

export function validateTaskText(task, maxChars) {
  if (typeof task !== "string") {
    throw new BridgeError("TASK_INVALID", "task must be a string.");
  }
  const trimmed = task.trim();
  if (!trimmed) {
    throw new BridgeError("TASK_INVALID", "task must not be empty.");
  }
  if (trimmed.length > maxChars) {
    throw new BridgeError("TASK_TOO_LARGE", `task exceeds the ${maxChars}-character limit.`);
  }
  if (trimmed.includes("\0")) {
    throw new BridgeError("TASK_INVALID", "task contains an invalid NUL character.");
  }
  return trimmed;
}
