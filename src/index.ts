import { resolveConfigPath, startServer } from "./server.js";

void Promise.resolve()
  .then(() => resolveConfigPath())
  .then(() => startServer())
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
