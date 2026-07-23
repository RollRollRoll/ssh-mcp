import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const DEFAULT_CONFIG_FILENAME = "ssh-mcp.yml";

export function createDefaultConfig(configPath: string): boolean {
  try {
    writeFileSync(configPath, renderDefaultConfig(dirname(configPath)), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    return true;
  } catch (error: unknown) {
    if (isFileExistsError(error)) return false;
    throw error;
  }
}

export function renderDefaultConfig(workingDirectory: string): string {
  return `# SSH MCP 首次启动生成的配置模板。
# 请先替换主机地址、用户名、认证方式和远程根目录，再重新启动。
# 建议每个项目或安全边界使用独立配置和 trustStore；不要提交实际配置。
version: 1
trustStore: ${JSON.stringify(join(workingDirectory, ".ssh-mcp-trust.json"))}
localRoots:
  - ${JSON.stringify(workingDirectory)}
hosts:
  - alias: example-development
    environment: development
    platform: linux
    host: 192.0.2.10
    port: 22
    username: replace-me
    auth:
      type: privateKeyFile
      path: ~/.ssh/id_ed25519
    shell:
      type: posix
      command: /bin/sh
    remoteRoots:
      - /absolute/remote/path
lowRiskProfiles: []
`;
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
