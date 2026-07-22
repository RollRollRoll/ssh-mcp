import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { testWithIds } from "../../test-with-ids.js";
import { buildCommand } from "../../../src/commands/command-builder.js";
import { CommandRunner } from "../../../src/commands/command-runner.js";
import type { HostConfig } from "../../../src/config/schema.js";
import { OperationManager } from "../../../src/operations/operation-manager.js";
import { ProfileCompiler } from "../../../src/policy/profile-compiler.js";
import { PolicyEngine } from "../../../src/policy/policy-engine.js";
import { ProfileRemotePathVerifier } from "../../../src/policy/profile-remote-path-verifier.js";
import { StrictHostKeyVerifier, type TrustConfirmation } from "../../../src/ssh/host-key.js";
import { SshAdapter } from "../../../src/ssh/ssh-adapter.js";
import { TrustStore } from "../../../src/ssh/trust-store.js";
import { ApprovalService } from "../../../src/approval/approval-service.js";
import { CommandApplicationService } from "../../../src/application/command-application-service.js";
import { ProfileApplicationService } from "../../../src/application/profile-application-service.js";
import { OperationControlService } from "../../../src/console/operation-control-service.js";
import { HostRegistry } from "../../../src/hosts/host-registry.js";

const windowsHost = {
  alias: "windows-fixture", environment: "test" as const, platform: "windows" as const,
  host: "127.0.0.1", port: 22, username: "sshmcp",
  auth: { type: "privateKeyFile" as const, path: "C:\\fixture\\client" },
  shell: { type: "powershell" as const, command: "powershell.exe" }, remoteRoots: ["C:\\Temp"]
};

describe("Windows OpenSSH command", () => {
  it.skipIf(!windowsIntegrationAvailable())(
    "IT-WINDOWS-CONSOLE-01：网页命令/Profile 复用首次 TOFU、输出与取消安全路径",
    async () => {
      let operationSequence = 0;
      const manager = new OperationManager({
        idFactory: () => `windows-web-${++operationSequence}`,
        limits: { cancelConfirmationTimeoutMs: 10_000 }
      });
      let tofuConfirmations = 0;
      const confirmation: TrustConfirmation = {
        supportsForm: () => true,
        confirm: async () => { tofuConfirmations += 1; return "accept"; }
      };
      const host = windowsIntegrationHost();
      const runner = new CommandRunner(new SshAdapter(new StrictHostKeyVerifier(
        new TrustStore(join(requiredEnv("SSH_MCP_WINDOWS_LOCAL_ROOT"), `web-trust-${Date.now()}.json`)),
        confirmation
      )), manager);
      const approval = new ApprovalService({
        supportsFormElicitation: () => false,
        elicit: async () => ({ action: "cancel" })
      }, undefined, 20_000, manager);
      const registry = new HostRegistry([host]);
      const commands = new CommandApplicationService(registry, approval, runner);
      const profiles = new ProfileApplicationService(registry, new PolicyEngine([{
        id: "web-echo", hostAliases: [host.alias], platform: "windows", commandType: "cmdlet",
        executable: "Write-Output", fixedArgs: [],
        parameters: [{ type: "enum", name: "InputObject", required: true, values: ["网页-Profile"] }]
      }]), runner, approval);
      const control = new OperationControlService(approval.coordinator, manager);

      try {
        const command = commands.preview({ host: host.alias, command: "Write-Output '网页-命令'" });
        expect(approval.coordinator.decide(command.approvalId, "accept").status).toBe("resolved");
        await expect(command.result).resolves.toMatchObject({ approved: true });
        await waitForTerminal(manager, command.operationId!);
        expect(manager.describeForConsole(command.operationId!)).toMatchObject({
          state: "completed", source: "web", kind: "command"
        });
        expect(manager.get(command.operationId!).frames.map((frame) => frame.data).join(""))
          .toContain("网页-命令");
        expect(tofuConfirmations).toBe(1);

        const profile = profiles.preview({
          host: host.alias, profileId: "web-echo", parameters: { InputObject: "网页-Profile" }
        });
        approval.coordinator.decide(profile.approvalId, "accept");
        await profile.result;
        await waitForTerminal(manager, profile.operationId!);
        expect(manager.get(profile.operationId!).frames.map((frame) => frame.data).join(""))
          .toContain("网页-Profile");

        const cancellation = commands.preview({
          host: host.alias,
          command: "Write-Output 'cancel-ready'; [Console]::Out.Flush(); Start-Sleep -Seconds 120"
        });
        approval.coordinator.decide(cancellation.approvalId, "accept");
        await cancellation.result;
        await waitForOutput(manager, cancellation.operationId!, "cancel-ready");
        expect(control.cancel(cancellation.operationId!)).toMatchObject({ status: "cancel_requested" });
        await waitForTerminal(manager, cancellation.operationId!);
        expect(manager.get(cancellation.operationId!).state).toBe("cancelled");
      } finally {
        approval.shutdown();
        await manager.shutdown(10_000);
      }
    }
  );

  it("固定 PowerShell UTF-16LE EncodedCommand，不使用 Linux Shell 包装", () => {
    const command = "Write-Output '中文'\r\nexit 0";
    const actual = buildCommand(windowsHost, command);
    expect(actual).toMatch(/^"powershell\.exe" -NoLogo -NoProfile -NonInteractive -EncodedCommand /);
    expect(Buffer.from(actual.split(" ").at(-1)!, "base64").toString("utf16le")).toBe(command);
    expect(actual).not.toContain(" -lc ");
  });

  testWithIds.skipIf(!windowsIntegrationAvailable())(["SC-052"], "受支持 Windows runner 执行真实 OpenSSH 和 UTF-16LE 命令", async () => {
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

  it.skipIf(!windowsIntegrationAvailable())("低风险 Profile 在 exec 前拒绝真实 junction/reparse point", async () => {
    let sequence = 0;
    const manager = new OperationManager({ idFactory: () => `windows-profile-reparse-${++sequence}` });
    const confirmation: TrustConfirmation = { supportsForm: () => true, confirm: async () => "accept" };
    const runner = new CommandRunner(
      new SshAdapter(new StrictHostKeyVerifier(new TrustStore(requiredEnv("SSH_MCP_WINDOWS_TRUST_STORE")), confirmation)),
      manager
    );
    const target = `C:\\Temp\\ssh-mcp-profile-junction-${process.pid}-${Date.now()}`;
    const actualHost = windowsIntegrationHost();
    try {
      await runToTerminal(runner, manager, actualHost,
        `New-Item -ItemType Junction -Path '${target}' -Target 'C:\\Windows' -ErrorAction Stop | Out-Null`);
      const decision = new PolicyEngine([{
        id: "list-safe", hostAliases: [actualHost.alias], platform: "windows", commandType: "cmdlet",
        executable: "Get-ChildItem", parameters: [{ type: "remotePath", name: "LiteralPath", required: true }]
      }]).evaluate({ profileId: "list-safe", host: actualHost, parameters: { LiteralPath: target } });
      expect(decision.matched).toBe(true);
      if (!decision.matched) return;
      const operation = runner.start(
        actualHost,
        new ProfileCompiler().compile(decision.match),
        undefined,
        new ProfileRemotePathVerifier().create(decision.match)
      );
      await waitForTerminal(manager, operation.operationId);
      expect(manager.get(operation.operationId)).toMatchObject({
        state: "failed", error: { code: "POLICY_REQUIRES_APPROVAL" }, result: { stdoutBytes: 0, stderrBytes: 0 }
      });
    } finally {
      await runToTerminal(runner, manager, actualHost,
        `Remove-Item -LiteralPath '${target}' -Force -ErrorAction SilentlyContinue`);
    }
  });

  it.skipIf(!windowsIntegrationAvailable())("真实 PowerShell Cmdlet 保持命名参数和 false switch 语义", async () => {
    let operationSequence = 0;
    const manager = new OperationManager({ idFactory: () => `windows-profile-${Date.now()}-${++operationSequence}` });
    const confirmation: TrustConfirmation = { supportsForm: () => true, confirm: async () => "accept" };
    const runner = new CommandRunner(
      new SshAdapter(new StrictHostKeyVerifier(new TrustStore(requiredEnv("SSH_MCP_WINDOWS_TRUST_STORE")), confirmation)),
      manager
    );
    const host = windowsIntegrationHost();
    const fixturePath = `C:\\Temp\\ssh-mcp-profile-${process.pid}-${Date.now()}`;

    try {
      await runToTerminal(runner, manager, host,
        `New-Item -ItemType Directory -LiteralPath '${fixturePath}' -Force | Out-Null; New-Item -ItemType File -LiteralPath '${fixturePath}\\visible.txt' -Force | Out-Null; $hidden = New-Item -ItemType File -LiteralPath '${fixturePath}\\hidden.txt' -Force; $hidden.Attributes = $hidden.Attributes -bor [IO.FileAttributes]::Hidden`
      );

      const decision = new PolicyEngine([{
        id: "list-fixture",
        hostAliases: [host.alias],
        platform: "windows",
        commandType: "cmdlet",
        executable: "Get-ChildItem",
        parameters: [
          { type: "remotePath", name: "LiteralPath", required: true },
          { type: "boolean", name: "Force", required: true }
        ]
      }]).evaluate({ profileId: "list-fixture", host, parameters: { LiteralPath: fixturePath, Force: false } });
      expect(decision.matched).toBe(true);
      if (!decision.matched) return;

      const operation = runner.start(host, new ProfileCompiler().compile(decision.match));
      await waitForTerminal(manager, operation.operationId);
      const snapshot = manager.get(operation.operationId);
      expect(snapshot).toMatchObject({ state: "completed", result: { exitCode: 0 } });
      const output = snapshot.frames.map((frame) => frame.data).join("");
      expect(output).toContain("visible.txt");
      expect(output).not.toContain("hidden.txt");
    } finally {
      await runToTerminal(runner, manager, host, `Remove-Item -LiteralPath '${fixturePath}' -Recurse -Force -ErrorAction SilentlyContinue`);
    }
  });
});

describe.skipIf(!windowsIntegrationAvailable())("Windows OpenSSH 命令取消", () => {
  it("IT-WINDOWS-CANCEL-COMMAND-01：真实长命令由 OperationManager.cancel 停止并确认终态", async () => {
    const manager = new OperationManager({
      idFactory: () => "windows-command-cancel",
      limits: { cancelConfirmationTimeoutMs: 10_000 }
    });
    const confirmation: TrustConfirmation = { supportsForm: () => true, confirm: async () => "accept" };
    const runner = new CommandRunner(
      new SshAdapter(new StrictHostKeyVerifier(new TrustStore(requiredEnv("SSH_MCP_WINDOWS_TRUST_STORE")), confirmation)),
      manager
    );
    const operation = runner.start(
      windowsIntegrationHost(),
      "Write-Output 'cancel-ready'; [Console]::Out.Flush(); Start-Sleep -Seconds 120; Write-Output 'cancel-side-effect'"
    );

    await waitForOutput(manager, operation.operationId, "cancel-ready");
    expect(manager.cancel(operation.operationId).state).toBe("running");
    await waitForTerminal(manager, operation.operationId);
    const snapshot = manager.get(operation.operationId);
    expect(snapshot).toMatchObject({
      state: "cancelled",
      result: { host: "windows-openssh", platform: "windows" }
    });
    expect(snapshot.frames.map((frame) => frame.data).join(""))
      .not.toContain("cancel-side-effect");
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

async function waitForOutput(manager: OperationManager, operationId: string, expected: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const snapshot = manager.get(operationId);
    if (snapshot.frames.some((frame) => frame.data.includes(expected))) return;
    if (["completed", "failed", "timed_out", "cancelled", "unknown"].includes(snapshot.state)) {
      throw new Error(`Windows OpenSSH 命令在输出 ${expected} 前已终结为 ${snapshot.state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Windows OpenSSH 命令未输出 ${expected}`);
}

async function runToTerminal(runner: CommandRunner, manager: OperationManager, host: HostConfig, command: string): Promise<void> {
  const operation = runner.start(host, command);
  await waitForTerminal(manager, operation.operationId);
  expect(manager.get(operation.operationId)).toMatchObject({ state: "completed", result: { exitCode: 0 } });
}
