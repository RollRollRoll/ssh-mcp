import { execFile } from "node:child_process";
import { lstat, mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ErrorCodes } from "../../../src/errors/error-codes.js";
import { type SftpPathPort, type SftpPathStat } from "../../../src/paths/linux-path-guard.js";
import { WindowsPathGuard } from "../../../src/paths/windows-path-guard.js";
import { WindowsReparseProbe } from "../../../src/paths/windows-reparse-probe.js";

const executeFile = promisify(execFile);
describe.skipIf(!windowsPathGuardAvailable())("Windows 路径守卫真实探针", () => {
  it("在受控目录建立普通目录、junction 和 symlink；固定探针与 PathGuard 都关闭拒绝重解析点", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ssh-mcp-path-guard-"));
    const target = path.join(directory, "target");
    const junction = path.join(directory, "junction");
    const symbolicLink = path.join(directory, "symbolic-link");
    try {
      await mkdir(target);
      // 门控开启后，缺少创建符号链接的权限或 Developer Mode 必须让本用例失败，不能静默降级为跳过。
      await runFixturePowerShell(
        [
          "$items = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) | ConvertFrom-Json -ErrorAction Stop",
          "New-Item -ItemType Junction -LiteralPath $items.junction -Target $items.target -ErrorAction Stop | Out-Null",
          "New-Item -ItemType SymbolicLink -LiteralPath $items.symbolicLink -Target $items.target -ErrorAction Stop | Out-Null"
        ].join("\n"),
        { target, junction, symbolicLink }
      );

      const probe = realPowerShellProbe();
      await expect(probe.probe([target, junction, symbolicLink])).resolves.toEqual([
        expect.objectContaining({ fullName: target, exists: true, reparse: false }),
        expect.objectContaining({ fullName: junction, exists: true, reparse: true }),
        expect.objectContaining({ fullName: symbolicLink, exists: true, reparse: true })
      ]);

      // 该适配器故意只暴露通用 SFTP 可表达的普通 file/directory 与稳定身份，
      // realpath 也仅返回词法路径；因此重解析点拒绝必须依赖真实固定探针，而非 SFTP 属性侥幸泄露。
      const guard = new WindowsPathGuard([directory], new GenericWindowsSftpMetadataPort(), probe);
      await expect(guard.verify(target)).resolves.toMatchObject({ canonical: target });
      await expect(guard.verify(junction)).rejects.toMatchObject({ code: ErrorCodes.LINK_NOT_ALLOWED });
      await expect(guard.verify(symbolicLink)).rejects.toMatchObject({ code: ErrorCodes.LINK_NOT_ALLOWED });
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it("配置第二盘符时必须使用盘符根格式且与本地根不同", () => {
    const secondDrive = requiredSecondDrive();
    const localRoot = requiredEnvironment("SSH_MCP_WINDOWS_LOCAL_ROOT");
    expect(secondDrive).toMatch(/^[A-Za-z]:\\$/);
    expect(secondDrive.toLocaleLowerCase("en-US"))
      .not.toBe(path.win32.parse(localRoot).root.toLocaleLowerCase("en-US"));
  });

  it("配置第二文件系统盘符时，WindowsPathGuard 词法入口关闭拒绝跨盘符请求", async () => {
    const secondDrive = requiredSecondDrive();
    expect(secondDrive).toMatch(/^[A-Za-z]:\\$/);
    const directory = await mkdtemp(path.join(tmpdir(), "ssh-mcp-path-guard-drive-"));
    try {
      const currentDrive = path.win32.parse(directory).root;
      expect(secondDrive.toLocaleLowerCase("en-US")).not.toBe(currentDrive.toLocaleLowerCase("en-US"));
      expect((await lstat(secondDrive)).isDirectory()).toBe(true);

      const guard = new WindowsPathGuard([directory], new GenericWindowsSftpMetadataPort(), realPowerShellProbe());
      await expect(guard.verify(path.win32.join(secondDrive, "ssh-mcp-path-guard-outside")))
        .rejects.toMatchObject({ code: ErrorCodes.PATH_DENIED });
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
});

function windowsPathGuardAvailable(): boolean {
  return process.platform === "win32" && process.env.SSH_MCP_WINDOWS_PATH_GUARD === "1";
}

function requiredSecondDrive(): string {
  return requiredEnvironment("SSH_MCP_WINDOWS_SECOND_DRIVE");
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`缺少 Windows 路径集成环境变量 ${name}`);
  return value;
}

function realPowerShellProbe(): WindowsReparseProbe {
  return new WindowsReparseProbe({
    execute: async (command) => {
      const encoded = encodedCommandArgument(command);
      const { stdout, stderr } = await executeFile(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        { encoding: "utf8", windowsHide: true }
      );
      return { stdout, stderr, code: 0 };
    }
  });
}

async function runFixturePowerShell(program: string, payload: Record<string, string>): Promise<void> {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const script = `$payload = '${encodedPayload}'\n${program}`;
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");
  await executeFile(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript],
    { encoding: "utf8", windowsHide: true }
  );
}

function encodedCommandArgument(command: string): string {
  const match = /(?:^|\s)-EncodedCommand\s+([A-Za-z0-9+/=]+)$/.exec(command);
  if (match?.[1] === undefined) throw new Error("固定 Windows 重解析点探针未产生 EncodedCommand");
  return match[1];
}

/**
 * 测试替身以真实 Windows lstat/stat 的 dev:ino 生成稳定身份，却故意模仿
 * 不携带 reparse 标志的通用 SFTP：链接按其目标的普通文件/目录暴露，canonical 仅词法化。
 */
class GenericWindowsSftpMetadataPort implements SftpPathPort {
  public async lstat(remotePath: string): Promise<SftpPathStat> {
    const raw = await lstat(remotePath);
    const target = raw.isSymbolicLink() ? await stat(remotePath) : raw;
    const kind = target.isDirectory() ? "directory" : target.isFile() ? "file" : undefined;
    if (kind === undefined || !Number.isSafeInteger(raw.dev) || !Number.isSafeInteger(raw.ino)) {
      throw new Error("Windows 文件系统未提供可用于门控测试的普通 SFTP 元数据");
    }
    return { kind, id: `${raw.dev}:${raw.ino}` };
  }

  public async realpath(remotePath: string): Promise<string> {
    return path.win32.normalize(remotePath);
  }
}
