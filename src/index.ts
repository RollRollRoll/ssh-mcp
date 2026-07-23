#!/usr/bin/env node

import { resolveStartupConfig, startServer } from "./server.js";
import { JsonLogger, LogEvents } from "./observability/logger.js";
import { createDefaultConfig } from "./config/default-config.js";
import { startupFailureContext } from "./errors/startup-error.js";

export async function runMain(): Promise<void> {
  const resolution = resolveStartupConfig();
  if (resolution.source === "default" && createDefaultConfig(resolution.path, process.cwd())) {
    startupLogger.info(LogEvents.CONFIG_GENERATED, { state: "completed" });
    return;
  }

  const runtime = await startServer(resolution.path);
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
void runMain().catch((error: unknown) => {
  startupLogger.error(LogEvents.SERVICE_STOPPED, startupFailureContext(error));
  process.exitCode = 1;
});
