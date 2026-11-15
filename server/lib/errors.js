/**
 * Errors that are safe to show to an MCP client. `details` must never contain
 * credentials, tokens, or raw process environments.
 */
export class BridgeError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.details = details;
  }
}

export function toBridgeError(error, fallbackCode = "INTERNAL_ERROR") {
  if (error instanceof BridgeError) return error;

  const message =
    error instanceof Error && error.message
      ? error.message
      : typeof error === "string"
        ? error
        : "Unknown error";

  return new BridgeError(fallbackCode, message);
}

export function errorPayload(error, fallbackCode = "INTERNAL_ERROR") {
  const bridgeError = toBridgeError(error, fallbackCode);
  return {
    ok: false,
    error: {
      code: bridgeError.code,
      message: bridgeError.message,
      ...(bridgeError.details ? { details: bridgeError.details } : {})
    }
  };
}
