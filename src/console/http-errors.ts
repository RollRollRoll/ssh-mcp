export type ConsoleHttpErrorCode = "INVALID_REQUEST" | "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND" | "METHOD_NOT_ALLOWED" | "PAYLOAD_TOO_LARGE" | "RESOURCE_LIMIT"
  | "OPERATION_NOT_FOUND" | "OPERATION_EXPIRED" | "INVALID_CURSOR"
  | "HOST_NOT_REGISTERED" | "POLICY_NOT_FOUND" | "POLICY_NOT_APPLICABLE"
  | "APPROVAL_NOT_FOUND" | "APPROVAL_INTENT_MISMATCH" | "APPROVAL_ALREADY_RESOLVED";

export const CONSOLE_SECURITY_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY"
});

export class ConsoleHttpError extends Error {
  public constructor(readonly status: number, readonly code: ConsoleHttpErrorCode) {
    super(code);
    this.name = "ConsoleHttpError";
  }
}

export function consoleErrorBody(code: ConsoleHttpErrorCode): Readonly<Record<string, unknown>> {
  return Object.freeze({
    error: Object.freeze({
      code,
      finalState: "failed",
      retriable: false,
      sideEffects: "none"
    })
  });
}
