import { describe, expect, it } from "vitest";
import type { HostConfig } from "../../../src/config/schema.js";
import { SessionManager } from "../../../src/sessions/session-manager.js";
import { StrictHostKeyVerifier, type TrustConfirmation } from "../../../src/ssh/host-key.js";
import { SshAdapter } from "../../../src/ssh/ssh-adapter.js";
import { TrustStore } from "../../../src/ssh/trust-store.js";

describe("Windows OpenSSH session PTY 会话", () => {
  it.skipIf(!available())("受支持 Windows runner 真实启动登记 PowerShell，保持上下文、尺寸、隔离和断连语义", async () => {
    const manager = new SessionManager({ idFactory: sequence("windows-a", "windows-b") });
    const target = host();
    const confirmation: TrustConfirmation = { supportsForm: () => true, confirm: async () => "accept" };
    const adapter = new SshAdapter(new StrictHostKeyVerifier(new TrustStore(required("SSH_MCP_WINDOWS_TRUST_STORE")), confirmation));
    const first = await open(manager, adapter, target, "windows-a");
    const second = await open(manager, adapter, target, "windows-b");
    manager.resize(first, 140, 55);
    await manager.write(first, Buffer.from("$env:SSH_MCP_SESSION='中文'; Set-Location $env:TEMP; Write-Output ('PS:' + $PSVersionTable.PSEdition + ':' + (Get-Location).Path + ':' + $env:SSH_MCP_SESSION); Write-Output ('SIZE:' + [Console]::WindowWidth + 'x' + [Console]::WindowHeight)\r\n", "utf8"));
    await waitUntil(() => rendered(manager, first).includes("PS:") && rendered(manager, first).includes("中文"));
    await waitUntil(() => rendered(manager, first).includes("SIZE:140x55"));
    await manager.write(first, Buffer.from("Start-Sleep -Seconds 5\r\n"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await manager.write(first, Buffer.from([0x03]));
    await manager.write(first, Buffer.from("Write-Output 'after-control'\r\n"));
    await manager.write(second, Buffer.from("Write-Output ('B:' + $env:SSH_MCP_SESSION)\r\n"));
    await waitUntil(() => rendered(manager, first).includes("after-control"));
    await waitUntil(() => rendered(manager, second).includes("B:"));
    expect(rendered(manager, second)).not.toContain("中文");
    await manager.write(first, Buffer.from("exit\r\n"));
    await waitUntil(() => manager.get(first).state === "disconnected");
    manager.close(second);
    await waitUntil(() => manager.get(second).state === "closed");
  });
});

function available(): boolean {
  return process.platform === "win32" && [
    "SSH_MCP_WINDOWS_HOST", "SSH_MCP_WINDOWS_PORT", "SSH_MCP_WINDOWS_USER", "SSH_MCP_WINDOWS_PRIVATE_KEY", "SSH_MCP_WINDOWS_SHELL", "SSH_MCP_WINDOWS_TRUST_STORE"
  ].every((name) => process.env[name]?.trim().length);
}
function host(): HostConfig {
  return {
    alias: "windows-openssh", environment: "test", platform: "windows", host: required("SSH_MCP_WINDOWS_HOST"), port: Number(required("SSH_MCP_WINDOWS_PORT")), username: required("SSH_MCP_WINDOWS_USER"),
    auth: { type: "privateKeyFile", path: required("SSH_MCP_WINDOWS_PRIVATE_KEY") }, shell: { type: "powershell", command: required("SSH_MCP_WINDOWS_SHELL") }, remoteRoots: ["C:\\Temp"]
  };
}
function required(name: string): string { const value = process.env[name]?.trim(); if (value === undefined || value.length === 0) throw new Error(`缺少 Windows 会话集成变量 ${name}`); return value; }
async function open(manager: SessionManager, adapter: SshAdapter, target: HostConfig, expectedId: string): Promise<string> {
  const reserved = manager.reserve({ host: target.alias, platform: target.platform, shell: target.shell.type, columns: 100, rows: 40 });
  expect(reserved.sessionId).toBe(expectedId);
  const connection = await adapter.connect(target);
  const channel = await new Promise<Parameters<SessionManager["activate"]>[2]>((resolve, reject) => {
    connection.openShell(100, 40, target.shell.command, (error, value) => error === undefined ? resolve(value as Parameters<SessionManager["activate"]>[2]) : reject(error));
  });
  manager.activate(reserved.sessionId, connection, channel);
  return reserved.sessionId;
}
function rendered(manager: SessionManager, id: string): string {
  return manager.get(id, 0, 262_144).frames.map((frame) => frame.encoding === "utf8" ? frame.data : Buffer.from(frame.data, "base64").toString("latin1")).join("");
}
function sequence(...ids: string[]): () => string { return () => ids.shift() ?? `extra-${Date.now()}`; }
async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error("Windows PTY 会话未在期限内达到预期状态");
}
