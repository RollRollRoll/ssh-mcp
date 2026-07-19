import { describe, expect, it } from "vitest";
import { testWithIds } from "../test-with-ids.js";
import { ErrorCodes } from "../../src/errors/error-codes.js";
import { LocalPathGuard, PathGuardError, lexicalPathHandle, type LocalFileSystem, type PathStat } from "../../src/paths/local-path-guard.js";
import { LinuxPathGuard, type SftpPathPort, type SftpPathStat } from "../../src/paths/linux-path-guard.js";
import { WindowsPathGuard } from "../../src/paths/windows-path-guard.js";
import { MAX_WINDOWS_REPARSE_PROBE_PATH_LENGTH, MAX_WINDOWS_REPARSE_PROBE_PATHS, MAX_WINDOWS_REPARSE_PROBE_STDOUT_BYTES, WindowsReparseProbe, buildWindowsReparseProbeCommand, parseWindowsReparseProbeOutput, type WindowsReparseProbePort } from "../../src/paths/windows-reparse-probe.js";

describe("路径守卫的纯词法入口", () => {
  testWithIds(["SC-040"], "零 I/O 地按路径段选择唯一根，并拒绝越界、相对、NUL、.. 和混合平台语义", () => {
    let calls = 0;
    const result = lexicalPathHandle("/workspace/project/readme.txt", ["/workspace"], "posix", () => { calls += 1; });
    expect(result).toMatchObject({ requested: "/workspace/project/readme.txt", canonical: "/workspace/project/readme.txt", root: "/workspace" });
    expect(calls).toBe(0);
    for (const value of ["relative", "/workspace/../secret", "/workspace\u0000/file", "C:\\workspace\\file", "/workspace2/file"]) {
      expect(() => lexicalPathHandle(value, ["/workspace"], "posix")).toThrow(PathGuardError);
    }
  });

  it("Windows 以盘符、分隔符与大小写进行路径段比较，拒绝盘符相对、根前缀和重叠根", () => {
    expect(lexicalPathHandle("c:/WORK/child.txt", ["C:\\Work"], "win32")).toMatchObject({
      canonical: "c:\\WORK\\child.txt", root: "C:\\Work"
    });
    for (const value of ["C:child.txt", "D:\\Work\\child.txt", "C:\\Work2\\child.txt", "/work/child.txt", "C:\\Work\\..\\secret"]) {
      expect(() => lexicalPathHandle(value, ["C:\\Work"], "win32")).toThrow(PathGuardError);
    }
    expect(() => lexicalPathHandle("C:\\Work\\child.txt", ["C:\\Work", "C:\\Work\\child.txt"], "win32")).toThrow(PathGuardError);
  });
});

describe("本地 PathGuard", () => {
  it("逐段拒绝符号链接，并在打开前与打开后复核身份", async () => {
    const fileSystem = new FakeLocalFileSystem({
      "/": directory(1, 0),
      "/safe": directory(1, 1),
      "/safe/data.txt": file(1, 2)
    });
    const guard = new LocalPathGuard(["/safe"], { platform: "posix", fileSystem });
    expect(guard.lexical("/safe/data.txt")).toMatchObject({ canonical: "/safe/data.txt" });
    expect(fileSystem.lstatCalls).toBe(0);
    const handle = await guard.verify("/safe/data.txt");
    await handle.revalidateBeforeOpen();
    fileSystem.onOpen = () => { fileSystem.entries.set("/safe/data.txt", file(1, 3)); };
    await expect(handle.openReadOnly()).rejects.toMatchObject({ code: ErrorCodes.PATH_DENIED });
    expect(fileSystem.openCalls).toEqual(["/safe/data.txt"]);
    expect(fileSystem.closeCalls).toBe(1);

    fileSystem.entries.set("/safe/data.txt", symlink(1, 4));
    await expect(guard.verify("/safe/data.txt")).rejects.toMatchObject({ code: ErrorCodes.LINK_NOT_ALLOWED });
  });

  it("只允许不存在目标位于已验证的最近存在祖先下", async () => {
    const fileSystem = new FakeLocalFileSystem({ "/": directory(1, 0), "/safe": directory(1, 1), "/safe/new": directory(1, 2) });
    const guard = new LocalPathGuard(["/safe"], { platform: "posix", fileSystem });
    await expect(guard.verify("/safe/new/file.txt")).resolves.toMatchObject({ canonical: "/safe/new/file.txt" });
    fileSystem.entries.set("/safe/new", symlink(1, 3));
    await expect(guard.verify("/safe/new/file.txt")).rejects.toMatchObject({ code: ErrorCodes.LINK_NOT_ALLOWED });
  });

  it("不存在的 Windows 最终目标在复核后被替换为重解析点时绝不打开", async () => {
    const fileSystem = new FakeLocalFileSystem({ "C:\\": directory(1, 0), "C:\\Safe": directory(1, 1) });
    const guard = new LocalPathGuard(["C:\\Safe"], { platform: "win32", fileSystem });
    const missing = await guard.verify("C:\\Safe\\still-missing.txt");
    await expect(missing.openReadOnly()).rejects.toMatchObject({ code: ErrorCodes.PATH_DENIED });
    expect(fileSystem.openCalls).toEqual([]);
    const handle = await guard.verify("C:\\Safe\\new.txt");
    await handle.revalidateBeforeOpen();
    fileSystem.entries.set("C:\\Safe\\new.txt", symlink(1, 2));
    await expect(handle.openReadOnly()).rejects.toMatchObject({ code: ErrorCodes.PATH_DENIED });
    expect(fileSystem.openCalls).toEqual([]);
  });

  it("身份字段不完整或打开后无法复核时关闭失败", async () => {
    for (const [dev, ino] of [[undefined, 2], ["bad", 2], [Number.NaN, 2], [Infinity, 2], [-1, 2], [1, -1]]) {
      const missingAtPreflight = new FakeLocalFileSystem({
        "/": directory(1, 0), "/safe": directory(1, 1), "/safe/data.txt": fileWithRawIdentity(dev, ino)
      });
      await expect(new LocalPathGuard(["/safe"], { platform: "posix", fileSystem: missingAtPreflight }).verify("/safe/data.txt"))
        .rejects.toMatchObject({ code: ErrorCodes.PATH_DENIED });
      expect(missingAtPreflight.openCalls).toEqual([]);
    }

    const replacedOnOpen = new FakeLocalFileSystem({
      "/": directory(1, 0), "/safe": directory(1, 1), "/safe/data.txt": file(1, 2)
    });
    const handle = await new LocalPathGuard(["/safe"], { platform: "posix", fileSystem: replacedOnOpen }).verify("/safe/data.txt");
    replacedOnOpen.onOpen = () => { replacedOnOpen.entries.set("/safe/data.txt", fileWithoutIdentity()); };
    await expect(handle.openReadOnly()).rejects.toMatchObject({ code: ErrorCodes.PATH_DENIED });
    expect(replacedOnOpen.closeCalls).toBe(1);
  });

  it("只允许文件或目录，且不能穿过普通文件", async () => {
    for (const unsupported of [other(1, 2), contradictoryType(1, 2)]) {
      const fileSystem = new FakeLocalFileSystem({ "/": directory(1, 0), "/safe": directory(1, 1), "/safe/unsupported": unsupported });
      await expect(new LocalPathGuard(["/safe"], { platform: "posix", fileSystem }).verify("/safe/unsupported"))
        .rejects.toMatchObject({ code: ErrorCodes.PATH_DENIED });
    }
    const fileSystem = new FakeLocalFileSystem({ "/": directory(1, 0), "/safe": directory(1, 1), "/safe/plain-file": file(1, 2) });
    await expect(new LocalPathGuard(["/safe"], { platform: "posix", fileSystem }).verify("/safe/plain-file/child"))
      .rejects.toMatchObject({ code: ErrorCodes.PATH_DENIED });
  });
});

describe("Linux SFTP PathGuard", () => {
  it("对每个存在段做 realpath/lstat，拒绝链接、越界与预检后的变化", async () => {
    const sftp = new FakeSftp({
      "/": { path: "/", kind: "directory", id: "filesystem" },
      "/srv": { path: "/srv", kind: "directory", id: "root" },
      "/srv/data": { path: "/srv/data", kind: "directory", id: "data" },
      "/srv/data/file": { path: "/srv/data/file", kind: "file", id: "file-1" }
    });
    const guard = new LinuxPathGuard(["/srv"], sftp);
    const handle = await guard.verify("/srv/data/file");
    await handle.revalidateBeforeOpen();
    sftp.entries.set("/srv/data/file", { path: "/srv/data/file", kind: "file", id: "file-2" });
    await expect(handle.revalidateBeforeOpen()).rejects.toMatchObject({ code: ErrorCodes.PATH_DENIED });
    sftp.entries.set("/srv/data/file", { path: "/srv/data/file", kind: "symlink", id: "link" });
    await expect(guard.verify("/srv/data/file")).rejects.toMatchObject({ code: ErrorCodes.LINK_NOT_ALLOWED });
    const unavailable = new LinuxPathGuard(["/srv"], { lstat: async () => { throw new Error("network diagnostics must stay hidden"); }, realpath: async () => "/srv" });
    await expect(unavailable.verify("/srv/data/file")).rejects.toMatchObject({ code: ErrorCodes.PATH_DENIED, message: ErrorCodes.PATH_DENIED });
  });

  it("缺失、空白或不合规的稳定身份均拒绝签发句柄", async () => {
    for (const id of [undefined, "", "contains space", "x".repeat(513)]) {
      const sftp = new FakeSftp({ "/": { path: "/", kind: "directory", id } });
      await expect(new LinuxPathGuard(["/"], sftp).verify("/")).rejects.toMatchObject({ code: ErrorCodes.PATH_DENIED });
    }
  });

  it("仅接受文件或目录，且中间段必须是目录", async () => {
    for (const kind of ["other", undefined, "unknown"]) {
      const sftp = new FakeSftp({
        "/": { path: "/", kind: "directory", id: "filesystem" },
        "/srv": { path: "/srv", kind: "directory", id: "root" },
        "/srv/unsupported": { path: "/srv/unsupported", kind, id: "unsupported" }
      });
      await expect(new LinuxPathGuard(["/srv"], sftp).verify("/srv/unsupported")).rejects.toMatchObject({ code: ErrorCodes.PATH_DENIED });
    }
    const sftp = new FakeSftp({
      "/": { path: "/", kind: "directory", id: "filesystem" },
      "/srv": { path: "/srv", kind: "directory", id: "root" },
      "/srv/plain-file": { path: "/srv/plain-file", kind: "file", id: "file" }
    });
    await expect(new LinuxPathGuard(["/srv"], sftp).verify("/srv/plain-file/child")).rejects.toMatchObject({ code: ErrorCodes.PATH_DENIED });
  });
});

describe("Windows SFTP 与固定 reparse 探针", () => {
  it("探针只嵌入 base64 JSON 数据，解析严格拒绝不可信输出", async () => {
    const malicious = "C:\\Work\\'; Remove-Item C:\\*; #";
    const command = buildWindowsReparseProbeCommand([malicious]);
    const script = Buffer.from(command.split(" ").at(-1)!, "base64").toString("utf16le");
    expect(command).toMatch(/^"powershell(?:\.exe)?" -NoLogo -NoProfile -NonInteractive -EncodedCommand /);
    expect(script).not.toContain(malicious);
    expect(script).toContain(Buffer.from(JSON.stringify([malicious]), "utf8").toString("base64"));
    expect(script).toContain("ConvertTo-Json -InputObject @($result) -Compress");
    expect(parseWindowsReparseProbeOutput('[{"fullName":"C:\\\\Work","exists":true,"reparse":false}]', 1)).toEqual([
      { fullName: "C:\\Work", exists: true, reparse: false }
    ]);
    expect(() => parseWindowsReparseProbeOutput("not json", 1)).toThrow(PathGuardError);
    expect(() => parseWindowsReparseProbeOutput('{"fullName":"C:\\\\Work","exists":true,"reparse":false}', 1)).toThrow(PathGuardError);
    expect(() => parseWindowsReparseProbeOutput('[{"fullName":"C:\\\\Work","exists":true,"reparse":false,"unexpected":true}]', 1)).toThrow(PathGuardError);
    expect(() => parseWindowsReparseProbeOutput('[{"fullName":"C:\\\\Work","exists":true,"reparse":false},{"fullName":"C:\\\\Work","exists":true,"reparse":false}]', 1)).toThrow(PathGuardError);
    expect(() => parseWindowsReparseProbeOutput(`[{"fullName":"${"x".repeat(MAX_WINDOWS_REPARSE_PROBE_PATH_LENGTH + 1)}","exists":true,"reparse":false}]`, 1)).toThrow(PathGuardError);
    expect(() => parseWindowsReparseProbeOutput(" ".repeat(MAX_WINDOWS_REPARSE_PROBE_STDOUT_BYTES + 1), 1)).toThrow(PathGuardError);
    expect(() => buildWindowsReparseProbeCommand([])).toThrow(PathGuardError);
    expect(() => buildWindowsReparseProbeCommand(Array.from({ length: MAX_WINDOWS_REPARSE_PROBE_PATHS + 1 }, () => "C:\\Work"))).toThrow(PathGuardError);
    expect(() => buildWindowsReparseProbeCommand(["C:\\" + "x".repeat(MAX_WINDOWS_REPARSE_PROBE_PATH_LENGTH)])).toThrow(PathGuardError);
    let executorCalls = 0;
    const invalidRequestProbe = new WindowsReparseProbe({ execute: async () => { executorCalls += 1; return { stdout: "[]", stderr: "", code: 0 }; } });
    await expect(invalidRequestProbe.probe([])).rejects.toMatchObject({ code: ErrorCodes.PATH_DENIED });
    expect(executorCalls).toBe(0);
    const rejectedProbe = new WindowsReparseProbe({ execute: async () => ({ stdout: "[]", stderr: "probe failed", code: 1 }) });
    await expect(rejectedProbe.probe(["C:\\Work"])).rejects.toMatchObject({ code: ErrorCodes.PATH_DENIED });
  });

  it("SFTP 与探针必须一致，任意 reparse 或探针失败均关闭失败", async () => {
    const sftp = new FakeSftp({
      "C:\\": { path: "C:\\", kind: "directory", id: "volume" },
      "C:\\Work": { path: "C:\\Work", kind: "directory", id: "root" },
      "C:\\Work\\data": { path: "C:\\Work\\data", kind: "directory", id: "data" }
    });
    const probe = new FakeProbe([
      { fullName: "C:\\", exists: true, reparse: false },
      { fullName: "C:\\Work", exists: true, reparse: false },
      { fullName: "C:\\Work\\data", exists: true, reparse: false }
    ]);
    const guard = new WindowsPathGuard(["C:\\Work"], sftp, probe);
    await expect(guard.verify("c:/work/data/new.txt")).resolves.toMatchObject({ canonical: "C:\\Work\\data\\new.txt" });
    probe.result = [
      { fullName: "C:\\", exists: true, reparse: false },
      { fullName: "C:\\Work", exists: true, reparse: false },
      { fullName: "D:\\Work\\data", exists: true, reparse: false }
    ];
    await expect(guard.verify("C:\\Work\\data\\new.txt")).rejects.toMatchObject({ code: ErrorCodes.PATH_DENIED });
    probe.result = [
      { fullName: "C:\\", exists: true, reparse: false },
      { fullName: "C:\\Work", exists: true, reparse: false },
      { fullName: "C:\\Work\\data", exists: true, reparse: true }
    ];
    await expect(guard.verify("C:\\Work\\data\\new.txt")).rejects.toMatchObject({ code: ErrorCodes.LINK_NOT_ALLOWED });
  });

  it("Windows 缺少稳定身份或同路径同类型对象被替换时均关闭失败", async () => {
    const probe = new FakeProbe([
      { fullName: "C:\\", exists: true, reparse: false },
      { fullName: "C:\\Work", exists: true, reparse: false },
      { fullName: "C:\\Work\\data", exists: true, reparse: false },
      { fullName: "C:\\Work\\data\\file.txt", exists: true, reparse: false }
    ]);
    for (const id of [undefined, "", "contains space", "x".repeat(513)]) {
      const missing = new FakeSftp({ "C:\\": { path: "C:\\", kind: "directory", id } });
      await expect(new WindowsPathGuard(["C:\\Work"], missing, probe).verify("C:\\Work\\data\\file.txt")).rejects.toMatchObject({ code: ErrorCodes.PATH_DENIED });
    }
    const sftp = new FakeSftp({
      "C:\\": { path: "C:\\", kind: "directory", id: "volume" },
      "C:\\Work": { path: "C:\\Work", kind: "directory", id: "root" },
      "C:\\Work\\data": { path: "C:\\Work\\data", kind: "directory", id: "data" },
      "C:\\Work\\data\\file.txt": { path: "C:\\Work\\data\\file.txt", kind: "file", id: "file-1" }
    });
    const handle = await new WindowsPathGuard(["C:\\Work"], sftp, probe).verify("C:\\Work\\data\\file.txt");
    sftp.entries.set("C:\\Work\\data\\file.txt", { path: "C:\\Work\\data\\file.txt", kind: "file", id: "file-2" });
    await expect(handle.revalidateBeforeOpen()).rejects.toMatchObject({ code: ErrorCodes.PATH_DENIED });
  });

  it("Windows SFTP 仅接受文件或目录，且中间段必须是目录", async () => {
    const probe = new FakeProbe([
      { fullName: "C:\\", exists: true, reparse: false },
      { fullName: "C:\\Work", exists: true, reparse: false },
      { fullName: "C:\\Work\\unsupported", exists: true, reparse: false }
    ]);
    for (const kind of ["other", undefined, "unknown"]) {
      const sftp = new FakeSftp({
        "C:\\": { path: "C:\\", kind: "directory", id: "volume" },
        "C:\\Work": { path: "C:\\Work", kind: "directory", id: "root" },
        "C:\\Work\\unsupported": { path: "C:\\Work\\unsupported", kind, id: "unsupported" }
      });
      await expect(new WindowsPathGuard(["C:\\Work"], sftp, probe).verify("C:\\Work\\unsupported")).rejects.toMatchObject({ code: ErrorCodes.PATH_DENIED });
    }
    const sftp = new FakeSftp({
      "C:\\": { path: "C:\\", kind: "directory", id: "volume" },
      "C:\\Work": { path: "C:\\Work", kind: "directory", id: "root" },
      "C:\\Work\\plain-file": { path: "C:\\Work\\plain-file", kind: "file", id: "file" }
    });
    await expect(new WindowsPathGuard(["C:\\Work"], sftp, probe).verify("C:\\Work\\plain-file\\child"))
      .rejects.toMatchObject({ code: ErrorCodes.PATH_DENIED });
  });
});

function directory(dev: number, ino: number): PathStat { return { isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false, dev, ino }; }
function file(dev: number, ino: number): PathStat { return { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true, dev, ino }; }
function symlink(dev: number, ino: number): PathStat { return { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false, dev, ino }; }
function fileWithoutIdentity(): PathStat { return { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true }; }
function fileWithRawIdentity(dev: unknown, ino: unknown): PathStat {
  return { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true, dev, ino } as PathStat;
}
function other(dev: number, ino: number): PathStat { return { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => false, dev, ino }; }
function contradictoryType(dev: number, ino: number): PathStat { return { isSymbolicLink: () => false, isDirectory: () => true, isFile: () => true, dev, ino }; }

class FakeLocalFileSystem implements LocalFileSystem {
  public readonly entries = new Map<string, PathStat>();
  public readonly openCalls: string[] = [];
  public closeCalls = 0;
  public onOpen: (() => void) | undefined;
  public lstatCalls = 0;
  public constructor(entries: Record<string, PathStat>) { for (const [path, stat] of Object.entries(entries)) this.entries.set(path, stat); }
  public async lstat(path: string): Promise<PathStat> { this.lstatCalls += 1; const value = this.entries.get(path); if (value === undefined) throw Object.assign(new Error("不存在"), { code: "ENOENT" }); return value; }
  public async realpath(path: string): Promise<string> { await this.lstat(path); return path; }
  public async open(path: string): Promise<{ stat(): Promise<PathStat>; close(): Promise<void> }> {
    this.openCalls.push(path);
    this.onOpen?.();
    const current = await this.lstat(path);
    return { stat: async () => current, close: async () => { this.closeCalls += 1; } };
  }
}

class FakeSftp implements SftpPathPort {
  public readonly entries = new Map<string, { path: string; kind: unknown; id: unknown }>();
  public constructor(entries: Record<string, { path: string; kind: unknown; id: unknown }>) { for (const [path, stat] of Object.entries(entries)) this.entries.set(path, stat); }
  public async lstat(path: string): Promise<SftpPathStat> { const value = this.entries.get(path); if (value === undefined) throw Object.assign(new Error("not found"), { code: "ENOENT" }); return { kind: value.kind, id: value.id } as SftpPathStat; }
  public async realpath(path: string): Promise<string> { const value = this.entries.get(path); if (value === undefined) throw Object.assign(new Error("not found"), { code: "ENOENT" }); return value.path; }
}

class FakeProbe implements WindowsReparseProbePort {
  public constructor(public result: readonly { fullName: string; exists: boolean; reparse: boolean }[]) {}
  public async probe(): Promise<readonly { fullName: string; exists: boolean; reparse: boolean }[]> { return this.result; }
}
