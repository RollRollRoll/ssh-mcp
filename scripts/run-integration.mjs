import { spawnSync } from "node:child_process";

const platform = process.argv[2];
const selector = process.argv[3];
const files = {
  linux: {
    session: "tests/integration/linux/session.test.ts",
    command: "tests/integration/linux/command.test.ts",
    connection: "tests/integration/linux/connection.test.ts",
    "file-transfer": "tests/integration/linux/file-transfer.test.ts",
    "directory-transfer": "tests/integration/linux/directory-transfer.test.ts"
  },
  windows: {
    session: "tests/integration/windows/session.test.ts",
    command: "tests/integration/windows/command.test.ts",
    "path-guard": "tests/integration/windows/path-guard.test.ts",
    "file-transfer": "tests/integration/windows/file-transfer.test.ts",
    "directory-transfer": "tests/integration/windows/directory-transfer.test.ts"
  }
};

if (!(platform in files) || (selector !== undefined && !(selector in files[platform]))) {
  process.stderr.write("集成测试选择器无效。\n");
  process.exitCode = 2;
} else {
  const target = selector === undefined ? `tests/integration/${platform}` : files[platform][selector];
  const result = spawnSync(process.execPath, ["./node_modules/vitest/vitest.mjs", "run", "--config", "vitest.integration.config.ts", target], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
}
