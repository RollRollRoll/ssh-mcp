import { startServer } from "./server.js";
import { ErrorCodes } from "./errors/error-codes.js";
import { JsonLogger, LogEvents } from "./observability/logger.js";

export async function runMain(): Promise<void> {
  const runtime = await startServer();
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void runtime.shutdown().catch(() => { process.exitCode = 1; });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

const startupLogger = new JsonLogger();
void runMain().catch(() => {
  startupLogger.error(LogEvents.SERVICE_STOPPED, { state: "failed", errorCode: ErrorCodes.INTERNAL_ERROR });
  process.exitCode = 1;
});
