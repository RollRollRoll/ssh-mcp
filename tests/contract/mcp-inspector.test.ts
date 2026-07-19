import { createHash, generateKeyPairSync } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { testWithIds } from "../test-with-ids.js";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const inspectorCli = resolveInspectorCli();
const children: ChildProcessWithoutNullStreams[] = [];
const inspectorProcesses = new Set<ControlledInspectorProcess>();
const fixtureDirectories: string[] = [];
const maxInspectorOutputBytes = 1024 * 1024;
const expectedTools = [
  "hosts_list", "command_run", "profile_run", "session_open", "session_write", "session_read",
  "session_resize", "session_close", "file_upload", "file_download", "operation_get", "operation_cancel"
].sort();

describe("MCP Inspector 协议验收", () => {
  afterEach(async () => {
    await Promise.all([...inspectorProcesses].map(async (process) => await process.stop()));
    for (const child of children) child.kill();
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }));
    children.length = 0;
    for (const directory of fixtureDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  testWithIds(["SC-001", "MN-004", "MN-005"], "AC-MCP-01：正式 MCP Inspector CLI 通过 stdio 发现精确 12 个工具并验证成功 structuredContent", async () => {
    const fixture = await createFixture();
    const listed = await inspector(fixture.configPath, "tools/list");
    expect(listed.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(expectedTools);

    const hosts = await inspector(fixture.configPath, "tools/call", "hosts_list");
    expect(hosts).toMatchObject({
      structuredContent: { hosts: [{ alias: "linux-test", environment: "test", platform: "linux", shell: "posix" }] }
    });
    expect(hosts.isError).not.toBe(true);
  });

  testWithIds(["SC-002", "SC-003", "MN-001"], "AC-MCP-02：正式 MCP Inspector CLI 严格拒绝额外及缺失字段，且不支持 form 时批准前零 SSH/文件副作用", async () => {
    const fixture = await createFixture();
    const extra = await inspector(fixture.configPath, "tools/call", "hosts_list", { host: "dynamic-host" });
    const missing = await inspector(fixture.configPath, "tools/call", "operation_get", {});
    const unsupported = await inspector(fixture.configPath, "tools/call", "command_run", {
      hosts: ["linux-test"], command: "echo never", dynamicUsername: "forbidden"
    });
    const approvalUnsupported = await inspector(fixture.configPath, "tools/call", "command_run", {
      hosts: ["linux-test"], command: "echo never"
    });

    expect(extra).toMatchObject({ isError: true });
    expect(missing).toMatchObject({ isError: true });
    expect(unsupported).toMatchObject({ isError: true });
    expect(approvalUnsupported).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "APPROVAL_UNSUPPORTED", sideEffects: "none" } }
    });
    expect(existsSync(fixture.trustStorePath)).toBe(false);
  });

  testWithIds(["SC-033"], "AC-MCP-03：补充的原始多请求会话创建长操作、查询、取消并读取确定终态", async () => {
    const fixture = await createFixture();
    const session = startRawSession(fixture.configPath);
    await session.initialize({});

    const started = toolStructured(await session.callTool("profile_run", {
      profileId: "long-running", hosts: ["linux-test"], parameters: {}
    }));
    expect(started).toMatchObject({ state: "running", operationId: expect.any(String) });
    const operationId = String(started.operationId);
    const running = toolStructured(await session.callTool("operation_get", { operationId }));
    expect(running).toMatchObject({
      operationId,
      host: "linux-test",
      target: { hosts: ["linux-test"] },
      state: "running",
      result: { host: "linux-test", stdoutBytes: 0, stderrBytes: 0 },
      frames: [],
      lastStateChangeAt: expect.any(Number)
    });
    const cancelled = toolStructured(await session.callTool("operation_cancel", { operationId }));
    expect(cancelled).toMatchObject({ operationId, state: "cancelled" });
    const terminal = toolStructured(await session.callTool("operation_get", { operationId }));
    expect(terminal).toMatchObject({ operationId, state: "cancelled", host: "linux-test" });
    expect(Number(terminal.lastStateChangeAt)).toBeGreaterThanOrEqual(Number(running.lastStateChangeAt));
    expect(existsSync(fixture.trustStorePath)).toBe(false);
  });

  it("AC-MCP-04：补充的 form framing 会话逐项核验目标、平台、canonical JSON、SHA-256 与 schema", async () => {
    const fixture = await createFixture();
    const session = startRawSession(fixture.configPath, "decline");
    await session.initialize({ elicitation: { form: {} } });
    const result = await session.callTool("command_run", { hosts: ["linux-test"], command: "echo never" });

    const canonicalJson = "{\"executionMode\":\"parallel\",\"hosts\":[\"linux-test\"],\"kind\":\"raw_command\",\"payload\":{\"command\":\"echo never\"},\"platformByHost\":{\"linux-test\":\"linux\"}}";
    const digest = createHash("sha256").update(canonicalJson, "utf8").digest("hex");
    expect(session.elicitation).toMatchObject({
      method: "elicitation/create",
      params: { mode: "form", requestedSchema: { type: "object", properties: {} } }
    });
    const params = session.elicitation?.params as { message?: unknown; requestedSchema?: unknown } | undefined;
    expect(params?.requestedSchema).toEqual({ type: "object", properties: {} });
    const message = String(params?.message);
    expect(message).toContain('目标主机（按顺序）：["linux-test"]');
    expect(message).toContain('主机平台：{"linux-test":"linux"}');
    expect(message).toContain(canonicalJson);
    expect(message).toContain(`SHA-256 摘要：${digest}`);
    expect(result).toMatchObject({ result: { isError: true, structuredContent: { error: { code: "APPROVAL_DECLINED", sideEffects: "none" } } } });
    expect(existsSync(fixture.trustStorePath)).toBe(false);
  });

  it("跨平台统一由 Node 执行锁定 Inspector 包声明的官方 CLI", async () => {
    const invocation = inspectorInvocation("fixture.json", "tools/list");
    expect(invocation.executable).toBe(process.execPath);
    expect(invocation.args[0]).toBe(inspectorCli);
    expect(inspectorCli.replaceAll("\\", "/")).toMatch(
      /node_modules\/@modelcontextprotocol\/inspector\/cli\/build\/cli\.js$/
    );
    const { stdout } = await runInspectorProcess(
      { executable: invocation.executable, args: [inspectorCli, "--help"] },
      10_000
    );
    expect(stdout).toContain("--cli");
  });

  it("Inspector 超时后回收挂起 MCP 服务的完整进程树", async () => {
    const fixture = createHangingInspectorFixture();
    let targetPid: number | undefined;
    try {
      await expect(inspector(fixture.configPath, "tools/list", undefined, undefined, 300)).rejects.toThrow();
      targetPid = await readPid(fixture.pidPath);
      await waitForProcessExit(targetPid, 1_000);
      expect(isProcessAlive(targetPid)).toBe(false);
    } finally {
      if (targetPid !== undefined && isProcessAlive(targetPid)) process.kill(targetPid, "SIGKILL");
    }
  });

  it("Windows 守护进程使用 KILL_ON_JOB_CLOSE 的 Job Object 约束完整后代树", () => {
    const invocation = windowsJobInvocation({ executable: "C:\\Program Files\\nodejs\\node.exe", args: ["outer.js", "引号'参数"] });
    expect(invocation.executable).toBe("powershell.exe");
    expect(invocation.args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    const program = Buffer.from(invocation.args[4]!, "base64").toString("utf16le");
    expect(program).toContain("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE");
    expect(program).toContain("AssignProcessToJobObject");
    expect(program).toContain("SetInformationJobObject");
    expect(program).toContain("CreateProcessW");
    expect(program).toContain("CREATE_SUSPENDED");
    expect(program).toContain("QuoteArgument");
    const createAt = program.indexOf("if (!CreateProcessW");
    const assignAt = program.indexOf("if (!AssignProcessToJobObject");
    const resumeAt = program.indexOf("if (ResumeThread");
    expect(createAt).toBeGreaterThan(-1);
    expect(createAt).toBeLessThan(assignAt);
    expect(assignAt).toBeLessThan(resumeAt);
    expect(program).toContain("CloseHandle");
    expect(program).not.toContain("Get-CimInstance");
    expect(program).not.toContain("Stop-Process");
    expect(program).not.toContain("& $Executable @Arguments");
    expect(program).not.toContain("C:\\Program Files\\nodejs\\node.exe");
    expect(program).not.toContain("引号'参数");
  });

  it.runIf(process.platform === "win32")("Windows Job Object 在外层与中间进程先退出后仍回收孤儿目标", async () => {
    const fixture = createOrphanedWindowsDescendantFixture();
    await runInspectorProcess({ executable: process.execPath, args: [fixture.outerPath, fixture.pidPath] }, 5_000);
    const targetPid = await readPid(fixture.pidPath);
    await waitForProcessExit(targetPid, 1_000);
    expect(isProcessAlive(targetPid)).toBe(false);
  });

  it.runIf(process.platform === "win32")("Windows Job 守护进程逐项保真 argv、stdio 与非零退出码", async () => {
    const fixture = createWindowsArgvEchoFixture();
    const expected = ["", "包含 空格", "尾部\\", '双"引号', "单'引号", '反斜杠\\\\\"组合', '["alpha","beta"]', '{"key":"value with space"}'];
    const result = await runInvocationRaw(windowsJobInvocation({
      executable: process.execPath,
      args: [fixture.scriptPath, ...expected]
    }));

    expect(result.code).toBe(23);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe(`${JSON.stringify(expected)}\n`);
    expect(result.stderr).toBe("stderr 原样输出\\尾部\n");
  });
});

async function runInvocationRaw(
  invocation: { readonly executable: string; readonly args: readonly string[] }
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly stdout: string; readonly stderr: string }> {
  const child = spawn(invocation.executable, invocation.args, {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  const result = await new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Windows Job argv fixture 在 10 秒内未退出"));
    }, 10_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  return {
    ...result,
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8")
  };
}

async function inspector(
  configPath: string,
  method: "tools/list" | "tools/call",
  toolName?: string,
  args?: Record<string, unknown>,
  timeoutMs = 10_000
): Promise<any> {
  const invocation = inspectorInvocation(configPath, method, toolName, args);
  const { stdout, stderr } = await runInspectorProcess(invocation, timeoutMs);
  expect(stderr).toBe("");
  return JSON.parse(stdout);
}

async function runInspectorProcess(
  invocation: { readonly executable: string; readonly args: readonly string[] },
  timeoutMs: number
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const process = new ControlledInspectorProcess(invocation);
  return await process.run(timeoutMs);
}

class ControlledInspectorProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly stdoutChunks: Buffer[] = [];
  private readonly stderrChunks: Buffer[] = [];
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private outputOverflow = false;
  private spawnError: Error | undefined;
  private exited = false;
  private stopPromise: Promise<void> | undefined;
  private readonly completion: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;

  public constructor(invocation: { readonly executable: string; readonly args: readonly string[] }) {
    const controlledInvocation = process.platform === "win32" ? windowsJobInvocation(invocation) : invocation;
    this.child = spawn(controlledInvocation.executable, controlledInvocation.args, {
      cwd: projectRoot,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    inspectorProcesses.add(this);
    this.child.stdout.on("data", (chunk: Buffer) => this.capture(chunk, this.stdoutChunks, "stdout"));
    this.child.stderr.on("data", (chunk: Buffer) => this.capture(chunk, this.stderrChunks, "stderr"));
    this.completion = new Promise((resolve) => {
      this.child.once("error", (error) => { this.spawnError = error; });
      this.child.once("close", (code, signal) => {
        this.exited = true;
        inspectorProcesses.delete(this);
        resolve({ code, signal });
      });
    });
  }

  public async run(timeoutMs: number): Promise<{ readonly stdout: string; readonly stderr: string }> {
    const timedOut = Symbol("Inspector 超时");
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), timeoutMs);
    });
    const result = await Promise.race([this.completion, timeout]);
    if (timer !== undefined) clearTimeout(timer);

    if (result === timedOut) {
      await this.stop();
      throw new Error(`Inspector CLI 在 ${timeoutMs}ms 内未退出`);
    }
    await this.stop();
    if (this.spawnError !== undefined) throw this.spawnError;
    if (this.outputOverflow) throw new Error(`Inspector CLI 输出超过 ${maxInspectorOutputBytes} 字节上限`);
    const stdout = Buffer.concat(this.stdoutChunks, this.stdoutBytes).toString("utf8");
    const stderr = Buffer.concat(this.stderrChunks, this.stderrBytes).toString("utf8");
    if (result.code !== 0) {
      throw new Error(`Inspector CLI 异常退出（code=${String(result.code)}, signal=${String(result.signal)}）：${stderr}`);
    }
    return { stdout, stderr };
  }

  public async stop(): Promise<void> {
    this.stopPromise ??= this.stopProcessTree();
    await this.stopPromise;
  }

  private capture(chunk: Buffer, chunks: Buffer[], stream: "stdout" | "stderr"): void {
    const currentBytes = stream === "stdout" ? this.stdoutBytes : this.stderrBytes;
    const remaining = maxInspectorOutputBytes - currentBytes;
    if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
    if (stream === "stdout") this.stdoutBytes += Math.min(chunk.length, Math.max(remaining, 0));
    else this.stderrBytes += Math.min(chunk.length, Math.max(remaining, 0));
    if (chunk.length > remaining) {
      this.outputOverflow = true;
      void this.stop().catch(() => undefined);
    }
  }

  private async stopProcessTree(): Promise<void> {
    const pid = this.child.pid;
    if (pid === undefined) {
      await this.waitForChildExit(1_000);
      return;
    }
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Inspector 返回无效 PID：${String(pid)}`);
    if (process.platform === "win32") {
      this.child.kill();
      if (!await this.waitForChildExit(1_000)) throw new Error(`Inspector Windows Job 守护进程 ${pid} 终止后仍未退出`);
      return;
    }

    this.signalPosixGroup(pid, "SIGINT");
    if (await this.waitForPosixGroupExit(pid, 500)) return;
    this.signalPosixGroup(pid, "SIGKILL");
    if (!await this.waitForPosixGroupExit(pid, 1_000)) {
      throw new Error(`Inspector POSIX 进程组 ${pid} 强制终止后仍未退出`);
    }
  }

  private signalPosixGroup(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  private async waitForPosixGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
    const gone = await waitUntil(() => !isPosixGroupAlive(pid), timeoutMs);
    if (!gone) return false;
    return await this.waitForChildExit(timeoutMs);
  }

  private async waitForChildExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return true;
    const timeout = new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs));
    return await Promise.race([this.completion.then(() => true as const), timeout]);
  }
}

function windowsJobInvocation(invocation: { readonly executable: string; readonly args: readonly string[] }): { readonly executable: string; readonly args: readonly string[] } {
  const executable = Buffer.from(invocation.executable, "utf8").toString("base64");
  const args = Buffer.from(JSON.stringify(invocation.args), "utf8").toString("base64");
  const program = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.ComponentModel;",
    "using System.Runtime.InteropServices;",
    "using System.Text;",
    "public static class InspectorJob {",
    "  private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;",
    "  private const uint CREATE_SUSPENDED = 0x00000004;",
    "  private const uint STARTF_USESTDHANDLES = 0x00000100;",
    "  private const uint HANDLE_FLAG_INHERIT = 0x00000001;",
    "  private const uint WAIT_OBJECT_0 = 0x00000000;",
    "  private const uint INFINITE = 0xFFFFFFFF;",
    "  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS { public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount; public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount; }",
    "  [StructLayout(LayoutKind.Sequential)] public struct BASIC_LIMITS { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }",
    "  [StructLayout(LayoutKind.Sequential)] public struct EXTENDED_LIMITS { public BASIC_LIMITS BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }",
    "  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public uint dwX; public uint dwY; public uint dwXSize; public uint dwYSize; public uint dwXCountChars; public uint dwYCountChars; public uint dwFillAttribute; public uint dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }",
    "  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId; }",
    "  [DllImport(\"kernel32.dll\", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);",
    "  [DllImport(\"kernel32.dll\", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint informationLength);",
    "  [DllImport(\"kernel32.dll\", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);",
    "  [DllImport(\"kernel32.dll\", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcessW(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);",
    "  [DllImport(\"kernel32.dll\", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);",
    "  [DllImport(\"kernel32.dll\", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);",
    "  [DllImport(\"kernel32.dll\", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);",
    "  [DllImport(\"kernel32.dll\", SetLastError = true)] private static extern bool TerminateProcess(IntPtr process, uint exitCode);",
    "  [DllImport(\"kernel32.dll\", SetLastError = true)] private static extern IntPtr GetStdHandle(int standardHandle);",
    "  [DllImport(\"kernel32.dll\", SetLastError = true)] private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);",
    "  [DllImport(\"kernel32.dll\", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);",
    "  private static string QuoteArgument(string value) {",
    "    if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\\t', '\\n', '\\v', '\\\"' }) < 0) return value;",
    "    StringBuilder output = new StringBuilder().Append('\\\"');",
    "    int backslashes = 0;",
    "    foreach (char character in value) {",
    "      if (character == '\\\\') { backslashes++; continue; }",
    "      if (character == '\\\"') { output.Append('\\\\', backslashes * 2 + 1).Append('\\\"'); backslashes = 0; continue; }",
    "      output.Append('\\\\', backslashes).Append(character);",
    "      backslashes = 0;",
    "    }",
    "    return output.Append('\\\\', backslashes * 2).Append('\\\"').ToString();",
    "  }",
    "  private static StringBuilder BuildCommandLine(string executable, string[] arguments) {",
    "    StringBuilder commandLine = new StringBuilder(QuoteArgument(executable));",
    "    foreach (string argument in arguments) commandLine.Append(' ').Append(QuoteArgument(argument));",
    "    return commandLine;",
    "  }",
    "  public static int Run(string executable, string[] arguments) {",
    "    IntPtr job = CreateJobObject(IntPtr.Zero, null);",
    "    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());",
    "    IntPtr information = IntPtr.Zero;",
    "    PROCESS_INFORMATION process = new PROCESS_INFORMATION();",
    "    try {",
    "      EXTENDED_LIMITS limits = new EXTENDED_LIMITS();",
    "      limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;",
    "      int size = Marshal.SizeOf(typeof(EXTENDED_LIMITS));",
    "      information = Marshal.AllocHGlobal(size);",
    "      Marshal.StructureToPtr(limits, information, false);",
    "      if (!SetInformationJobObject(job, 9, information, (uint)size)) throw new Win32Exception(Marshal.GetLastWin32Error());",
    "      STARTUPINFO startup = new STARTUPINFO();",
    "      startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));",
    "      startup.dwFlags = STARTF_USESTDHANDLES;",
    "      startup.hStdInput = GetStdHandle(-10);",
    "      startup.hStdOutput = GetStdHandle(-11);",
    "      startup.hStdError = GetStdHandle(-12);",
    "      if (!SetHandleInformation(startup.hStdInput, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) throw new Win32Exception(Marshal.GetLastWin32Error());",
    "      if (!SetHandleInformation(startup.hStdOutput, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) throw new Win32Exception(Marshal.GetLastWin32Error());",
    "      if (!SetHandleInformation(startup.hStdError, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) throw new Win32Exception(Marshal.GetLastWin32Error());",
    "      if (!CreateProcessW(executable, BuildCommandLine(executable, arguments), IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED, IntPtr.Zero, Environment.CurrentDirectory, ref startup, out process)) throw new Win32Exception(Marshal.GetLastWin32Error());",
    "      if (!AssignProcessToJobObject(job, process.hProcess)) throw new Win32Exception(Marshal.GetLastWin32Error());",
    "      if (ResumeThread(process.hThread) == 0xFFFFFFFF) throw new Win32Exception(Marshal.GetLastWin32Error());",
    "      if (WaitForSingleObject(process.hProcess, INFINITE) != WAIT_OBJECT_0) throw new Win32Exception(Marshal.GetLastWin32Error());",
    "      uint exitCode;",
    "      if (!GetExitCodeProcess(process.hProcess, out exitCode)) throw new Win32Exception(Marshal.GetLastWin32Error());",
    "      return unchecked((int)exitCode);",
    "    } catch { if (process.hProcess != IntPtr.Zero) TerminateProcess(process.hProcess, 1); throw; }",
    "    finally {",
    "      if (information != IntPtr.Zero) Marshal.FreeHGlobal(information);",
    "      if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);",
    "      if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);",
    "      CloseHandle(job);",
    "    }",
    "  }",
    "}",
    "'@",
    `$Executable = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${executable}'))`,
    `[string[]]$Arguments = @([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${args}')) | ConvertFrom-Json)`,
    "$ExitCode = [InspectorJob]::Run($Executable, $Arguments)",
    "exit $ExitCode"
  ].join("\n");
  return Object.freeze({
    executable: "powershell.exe",
    args: Object.freeze(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(program, "utf16le").toString("base64")])
  });
}

function isPosixGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

function createHangingInspectorFixture(): { readonly configPath: string; readonly pidPath: string } {
  const directory = mkdtempSync(join(tmpdir(), "ssh-mcp-inspector-hanging-"));
  fixtureDirectories.push(directory);
  const pidPath = join(directory, "target.pid");
  const serverPath = join(directory, "hanging-server.mjs");
  writeFileSync(serverPath, [
    'import { writeFileSync } from "node:fs";',
    "writeFileSync(process.argv[2], String(process.pid));",
    "setInterval(() => undefined, 60_000);"
  ].join("\n"));
  const configPath = join(directory, "inspector.json");
  writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      "ssh-mcp": { type: "stdio", command: process.execPath, args: [serverPath, pidPath] }
    }
  }));
  return { configPath, pidPath };
}

function createOrphanedWindowsDescendantFixture(): { readonly outerPath: string; readonly pidPath: string } {
  const directory = mkdtempSync(join(tmpdir(), "ssh-mcp-inspector-orphan-"));
  fixtureDirectories.push(directory);
  const pidPath = join(directory, "target.pid");
  const targetPath = join(directory, "target.mjs");
  const middlePath = join(directory, "middle.mjs");
  const outerPath = join(directory, "outer.mjs");
  writeFileSync(targetPath, [
    'import { writeFileSync } from "node:fs";',
    "writeFileSync(process.argv[2], String(process.pid));",
    "setInterval(() => undefined, 60_000);"
  ].join("\n"));
  writeFileSync(middlePath, [
    'import { existsSync } from "node:fs";',
    'import { spawn } from "node:child_process";',
    "const child = spawn(process.execPath, [process.argv[3], process.argv[2]], { detached: true, stdio: 'ignore' });",
    "child.unref();",
    "const deadline = Date.now() + 2_000;",
    "while (!existsSync(process.argv[2]) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));",
    "if (!existsSync(process.argv[2])) process.exitCode = 2;"
  ].join("\n"));
  writeFileSync(outerPath, [
    'import { spawn } from "node:child_process";',
    `const child = spawn(process.execPath, [${JSON.stringify(middlePath)}, process.argv[2], ${JSON.stringify(targetPath)}], { stdio: 'ignore' });`,
    "const code = await new Promise((resolve) => child.once('close', resolve));",
    "process.exitCode = code ?? 3;"
  ].join("\n"));
  return { outerPath, pidPath };
}

function createWindowsArgvEchoFixture(): { readonly scriptPath: string } {
  const directory = mkdtempSync(join(tmpdir(), "ssh-mcp-inspector-argv-"));
  fixtureDirectories.push(directory);
  const scriptPath = join(directory, "argv-echo.mjs");
  writeFileSync(scriptPath, [
    "process.stdout.write(`${JSON.stringify(process.argv.slice(2))}\\n`);",
    'process.stderr.write("stderr 原样输出\\\\尾部\\n");',
    "process.exitCode = 23;"
  ].join("\n"));
  return { scriptPath };
}

async function readPid(pidPath: string): Promise<number> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (existsSync(pidPath)) {
      const pid = Number(readFileSync(pidPath, "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`挂起 MCP fixture 写入无效 PID：${String(pid)}`);
      return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("挂起 MCP fixture 未写入 PID");
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  if (await waitUntil(() => !isProcessAlive(pid), timeoutMs)) return;
  throw new Error(`挂起 MCP fixture 进程 ${pid} 未在限定时间内退出`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function inspectorInvocation(
  configPath: string,
  method: "tools/list" | "tools/call",
  toolName?: string,
  args?: Record<string, unknown>
): { readonly executable: string; readonly args: string[] } {
  const cliArgs = [inspectorCli, "--cli", "--config", configPath, "--server", "ssh-mcp", "--method", method];
  if (toolName !== undefined) cliArgs.push("--tool-name", toolName);
  for (const [key, value] of Object.entries(args ?? {})) cliArgs.push("--tool-arg", `${key}=${JSON.stringify(value)}`);
  return { executable: process.execPath, args: cliArgs };
}

function resolveInspectorCli(): string {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve("@modelcontextprotocol/inspector/package.json");
  const metadata = JSON.parse(readFileSync(packagePath, "utf8")) as {
    readonly name?: unknown;
    readonly version?: unknown;
    readonly bin?: Readonly<Record<string, unknown>>;
  };
  if (metadata.name !== "@modelcontextprotocol/inspector" || metadata.version !== "0.22.0"
    || metadata.bin?.["mcp-inspector"] !== "cli/build/cli.js") {
    throw new Error("锁定 Inspector 包的官方 CLI 元数据不符合预期");
  }
  const cliPath = resolve(dirname(packagePath), metadata.bin["mcp-inspector"]);
  if (!existsSync(cliPath)) throw new Error("锁定 Inspector 官方 CLI 不存在");
  return cliPath;
}

async function createFixture(): Promise<{ configPath: string; trustStorePath: string }> {
  const directory = mkdtempSync(join(tmpdir(), "ssh-mcp-inspector-"));
  fixtureDirectories.push(directory);
  const privateKeyPath = join(directory, "fixture-ed25519.pem");
  const privateKey = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
  writeFileSync(privateKeyPath, privateKey, { mode: 0o600 });
  // 稀疏扩展只为给多请求生命周期测试留下确定的取消窗口；内容是每次生成的无权限测试材料。
  truncateSync(privateKeyPath, 64 * 1024 * 1024);

  const serverConfigPath = join(directory, "server.yml");
  const trustStorePath = join(directory, "trust.json");
  writeFileSync(serverConfigPath, `
version: 1
trustStore: ${trustStorePath}
localRoots: [${directory}/local]
limits:
  connectTimeoutMs: 15000
  commandTimeoutMs: 15000
  sessionIdleTimeoutMs: 15000
  transferTimeoutMs: 15000
  approvalTimeoutMs: 5000
  cancelConfirmationTimeoutMs: 1000
  outputBufferBytes: 1048576
  resultRetentionMs: 15000
hosts:
  - alias: linux-test
    environment: test
    platform: linux
    host: 192.0.2.10
    port: 22
    username: developer
    auth: { type: privateKeyFile, path: ${privateKeyPath} }
    shell: { type: posix, command: /bin/sh }
    remoteRoots: [/srv/project]
lowRiskProfiles:
  - id: long-running
    hostAliases: [linux-test]
    platform: linux
    executable: /usr/bin/true
`);
  const configPath = join(directory, "inspector.json");
  writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      "ssh-mcp": { type: "stdio", command: process.execPath, args: ["dist/index.js", "--config", serverConfigPath] }
    }
  }));
  return { configPath, trustStorePath };
}

function startRawSession(configPath: string, elicitationAction: "decline" | "cancel" = "decline"): RawJsonRpcSession {
  const inspectorConfig = JSON.parse(readFileSync(configPath, "utf8")) as { mcpServers: { "ssh-mcp": { args: string[] } } };
  const child = spawn(process.execPath, inspectorConfig.mcpServers["ssh-mcp"].args, { cwd: projectRoot, stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  return new RawJsonRpcSession(child, elicitationAction);
}

class RawJsonRpcSession {
  public elicitation: JsonRpcMessage | undefined;
  private buffer = "";
  private nextId = 1;
  private readonly responses = new Map<number, (message: JsonRpcMessage) => void>();

  public constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly elicitationAction: "decline" | "cancel") {
    child.stdout.on("data", (chunk: Buffer) => this.read(chunk));
  }

  public async initialize(capabilities: Record<string, unknown>): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-11-25", capabilities, clientInfo: { name: "raw-framing-supplement", version: "1" }
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  }

  public async callTool(name: string, args: Record<string, unknown>): Promise<JsonRpcMessage> {
    return await this.request("tools/call", { name, arguments: args });
  }

  private request(method: string, params: Record<string, unknown>): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.responses.delete(id); reject(new Error(`原始 framing 会话未收到 ${method} 响应`)); }, 8_000);
      this.responses.set(id, (message) => { clearTimeout(timer); resolve(message); });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private read(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines.filter(Boolean)) {
      const message = JSON.parse(line) as JsonRpcMessage;
      if (message.method === "elicitation/create" && typeof message.id === "number") {
        this.elicitation = message;
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { action: this.elicitationAction } })}\n`);
        continue;
      }
      const listener = typeof message.id === "number" ? this.responses.get(message.id) : undefined;
      if (listener !== undefined && typeof message.id === "number") { this.responses.delete(message.id); listener(message); }
    }
  }
}

type JsonRpcMessage = { readonly id?: number; readonly method?: string; readonly params?: unknown; readonly result?: unknown; readonly error?: unknown };

function toolStructured(message: JsonRpcMessage): Record<string, unknown> {
  expect(message.error).toBeUndefined();
  return (message.result as { structuredContent?: Record<string, unknown> }).structuredContent!;
}
