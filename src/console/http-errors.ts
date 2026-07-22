export type ConsoleHttpErrorCode = "INVALID_REQUEST" | "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND" | "METHOD_NOT_ALLOWED" | "PAYLOAD_TOO_LARGE" | "RESOURCE_LIMIT";

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
