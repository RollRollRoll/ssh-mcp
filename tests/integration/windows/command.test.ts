import { describe, expect, it } from "vitest";
import { buildCommand } from "../../../src/commands/command-builder.js";
import { CommandRunner } from "../../../src/commands/command-runner.js";
import type { HostConfig } from "../../../src/config/schema.js";
import { OperationManager } from "../../../src/operations/operation-manager.js";
import { StrictHostKeyVerifier, type TrustConfirmation } from "../../../src/ssh/host-key.js";
import { SshAdapter } from "../../../src/ssh/ssh-adapter.js";
import { TrustStore } from "../../../src/ssh/trust-store.js";

const windowsHost = {
  alias: "windows-fixture", environment: "test" as const, platform: "windows" as const,
  host: "127.0.0.1", port: 22, username: "sshmcp",
  auth: { type: "privateKeyFile" as const, path: "C:\\fixture\\client" },
  shell: { type: "powershell" as const, command: "powershell.exe" }, remoteRoots: ["C:\\Temp"]
};

describe("Windows OpenSSH command", () => {
  it("固定 PowerShell UTF-16LE EncodedCommand，不使用 Linux Shell 包装", () => {
    const command = "Write-Output '中文'\r\nexit 0";
    const actual = buildCommand(windowsHost, command);
    expect(actual).toMatch(/^"powershell\.exe" -NoLogo -NoProfile -NonInteractive -EncodedCommand /);
    expect(Buffer.from(actual.split(" ").at(-1)!, "base64").toString("utf16le")).toBe(command);
    expect(actual).not.toContain(" -lc ");
  });

  it.skipIf(!windowsIntegrationAvailable())("受支持 Windows runner 执行真实 OpenSSH 和 UTF-16LE 命令", async () => {
    const manager = new OperationManager({ idFactory: () => "windows-command" });
    const confirmation: TrustConfirmation = { supportsForm: () => true, confirm: async () => "accept" };
    const runner = new CommandRunner(
      new SshAdapter(new StrictHostKeyVerifier(new TrustStore(requiredEnv("SSH_MCP_WINDOWS_TRUST_STORE")), confirmation)),
      manager
    );
    const operation = runner.start(windowsIntegrationHost(), "Write-Output '中文'; exit 0");

    await waitForTerminal(manager, operation.operationId);
    expect(manager.get(operation.operationId)).toMatchObject({
      state: "completed",
      result: { host: "windows-openssh", platform: "windows", exitCode: 0 }
    });
    expect(manager.get(operation.operationId).frames).toEqual(expect.arrayContaining([
      expect.objectContaining({ stream: "stdout", encoding: "utf8", data: expect.stringContaining("中文") })
    ]));
  });
});

function windowsIntegrationAvailable(): boolean {
  return process.platform === "win32" && [
    "SSH_MCP_WINDOWS_HOST",
    "SSH_MCP_WINDOWS_PORT",
    "SSH_MCP_WINDOWS_USER",
    "SSH_MCP_WINDOWS_PRIVATE_KEY",
    "SSH_MCP_WINDOWS_SHELL",
    "SSH_MCP_WINDOWS_TRUST_STORE"
  ].every((name) => process.env[name]?.trim().length);
}

function windowsIntegrationHost(): HostConfig {
  return {
    alias: "windows-openssh",
    environment: "test",
    platform: "windows",
    host: requiredEnv("SSH_MCP_WINDOWS_HOST"),
    port: Number(requiredEnv("SSH_MCP_WINDOWS_PORT")),
    username: requiredEnv("SSH_MCP_WINDOWS_USER"),
    auth: { type: "privateKeyFile", path: requiredEnv("SSH_MCP_WINDOWS_PRIVATE_KEY") },
    shell: { type: "powershell", command: requiredEnv("SSH_MCP_WINDOWS_SHELL") },
    remoteRoots: ["C:\\Temp"]
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`缺少 Windows OpenSSH 集成环境变量 ${name}`);
  return value;
}

async function waitForTerminal(manager: OperationManager, operationId: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (["completed", "failed", "timed_out", "cancelled", "unknown"].includes(manager.get(operationId).state)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Windows OpenSSH 命令未在期限内结束");
}
