import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workflow = read("../../.github/workflows/ci.yml");
const windowsCommand = read("../integration/windows/command.test.ts");
const windowsFileTransfer = read("../integration/windows/file-transfer.test.ts");
const windowsPathGuard = read("../integration/windows/path-guard.test.ts");

describe("Windows CI 静态交付闸门", () => {
  it("AC-WINDOWS-CI-01：管理员、SFTP、防火墙和 22 端口均显式校验", () => {
    expect(workflow).toContain("WindowsBuiltInRole]::Administrator");
    expect(workflow).toContain("Subsystem sftp sftp-server.exe");
    expect(workflow).toContain("OpenSSH-Server-In-TCP");
    expect(workflow).toContain("New-NetFirewallRule");
    expect(workflow).toContain("Test-NetConnection -ComputerName 127.0.0.1 -Port 22");
    expect(workflow).toContain("sftp.exe -q -b");
    expect(workflow).toContain("RUNNER_TEMP 与 SystemDrive 位于不同真实盘符");
    expect(workflow).toContain("$secondDrive = \"$systemDrive\\\"");
    expect(workflow).toContain("SSH_MCP_WINDOWS_SECOND_DRIVE=$secondDrive");
  });

  it("AC-WINDOWS-CI-02：仅记录本 job 创建的资源并始终执行清理", () => {
    expect(workflow).toContain("CapabilityInstalledByJob");
    expect(workflow).toContain("UserCreatedByJob");
    expect(workflow).toContain("FirewallRuleCreatedByJob");
    expect(workflow).toContain("SshdStartedByJob");
    expect(workflow).toContain("SshdConfigChangedByJob");
    expect(workflow).toMatch(/name: 清理本 job 创建的 Windows OpenSSH 资源\s+if: always\(\)/);
    expect(workflow.indexOf("if: always()")).toBeGreaterThan(workflow.indexOf("npm run test:integration:windows"));
    expect(workflow).toContain("Remove-LocalUser");
    expect(workflow).toContain("Remove-NetFirewallRule");
    expect(workflow).toContain("Remove-WindowsCapability");
  });

  it("AC-WINDOWS-CI-03：跨盘符与真实取消在启用 Windows 集成后不可二次跳过", () => {
    expect(windowsPathGuard).not.toContain("itWithSecondDrive");
    expect(windowsPathGuard).toContain('it("配置第二文件系统盘符时');
    assertPlainCancellationTest(windowsCommand, "IT-WINDOWS-CANCEL-COMMAND-01");
    assertPlainCancellationTest(windowsFileTransfer, "IT-WINDOWS-CANCEL-FILE-01");
  });
});

function assertPlainCancellationTest(source: string, id: string): void {
  const start = source.indexOf(`it("${id}`);
  expect(start, `${id} 必须是普通 it 用例`).toBeGreaterThanOrEqual(0);
  const body = source.slice(start, start + 3_000);
  expect(body, `${id} 必须调用 OperationManager.cancel`).toContain("manager.cancel(operation.operationId)");
  expect(body, `${id} 必须断言 cancelled 终态`).toContain('state: "cancelled"');
}

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}
