import { ErrorCodes, type ErrorCode } from "./error-codes.js";
import type { LogContext } from "../observability/logger.js";

const safeSystemErrorCodes = new Set([
  "EACCES",
  "EADDRINUSE",
  "EADDRNOTAVAIL",
  "EMFILE",
  "ENFILE",
  "EPERM"
]);

export class StartupError extends Error {
  public readonly name = "StartupError";

  public constructor(
    public readonly errorCode: ErrorCode,
    public readonly systemErrorCode: string | undefined,
    cause: unknown
  ) {
    super(errorCode, { cause });
  }
}

export function consoleStartupError(error: unknown): StartupError {
  if (error instanceof StartupError) return error;
  const systemErrorCode = safeSystemErrorCode(error);
  const errorCode = systemErrorCode === "EPERM" || systemErrorCode === "EACCES"
    ? ErrorCodes.CONSOLE_LISTEN_DENIED
    : ErrorCodes.CONSOLE_START_FAILED;
  return new StartupError(errorCode, systemErrorCode, error);
}

export function startupFailureContext(error: unknown): LogContext {
  if (!(error instanceof StartupError)) {
    return { state: "failed", errorCode: ErrorCodes.INTERNAL_ERROR };
  }
  return {
    state: "failed",
    errorCode: error.errorCode,
    ...(error.systemErrorCode === undefined
      ? {}
      : { details: { systemErrorCode: error.systemErrorCode } })
  };
}

function safeSystemErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  try {
    const code = error.code;
    return typeof code === "string" && safeSystemErrorCodes.has(code) ? code : undefined;
  } catch {
    return undefined;
  }
}
