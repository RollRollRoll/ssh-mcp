import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { testWithIds } from "../test-with-ids.js";
import { ApprovalService } from "../../src/approval/approval-service.js";
import { createOperationIntent } from "../../src/approval/operation-intent.js";
import type { HostConfig } from "../../src/config/schema.js";
import { CommandRunner } from "../../src/commands/command-runner.js";
import { ErrorCodes } from "../../src/errors/error-codes.js";
import { OperationManager, type MonotonicClock } from "../../src/operations/operation-manager.js";
import { LinuxPathGuard } from "../../src/paths/linux-path-guard.js";
import { SessionManager, SessionManagerError } from "../../src/sessions/session-manager.js";
import { AtomicTarget, type AtomicTargetPort } from "../../src/transfers/atomic-target.js";
import { DirectoryTransferService, type PreparedDirectoryTransfer } from "../../src/transfers/directory-transfer.js";
import { TransferService, type PreparedTransfer, type TransferRequest } from "../../src/transfers/file-transfer.js";

class Channel extends EventEmitter {
  public readonly stderr = new EventEmitter();
  public signals: string[] = [];
  public signal(value: string): void { this.signals.push(value); }
  public write(_data: Buffer, callback?: (error?: Error | null) => void): boolean { callback?.(); return true; }
  public setWindow(_rows: number, _columns: number, _height: number, _width: number): void {}
  public close(): void { this.emit("close", undefined, undefined); }
}

class FakeClock implements MonotonicClock {
  public nowMs = 0;
  private sequence = 0;
  private readonly timers = new Map<number, { due: number; callback: () => void }>();
  public now(): number { return this.nowMs; }
  public setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.sequence;
    this.timers.set(id, { due: this.nowMs + delayMs, callback });
    return id;
  }
  public clearTimeout(timer: unknown): void { this.timers.delete(timer as number); }
  public advance(delayMs: number): void {
    this.nowMs += delayMs;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.due <= this.nowMs);
      if (due.length === 0) return;
      for (const [id, timer] of due) { this.timers.delete(id); timer.callback(); }
    }
  }
}

const host: HostConfig = {
  alias: "linux", environment: "test", platform: "linux", host: "127.0.0.1", port: 22, username: "test",
  auth: { type: "privateKeyFile", path: "/tmp/key" }, shell: { type: "posix", command: "/bin/sh" }, remoteRoots: ["/tmp"]
};

describe("CommandRunner", () => {
  it("连接级 Profile 路径预检失败时不提交 exec 并关闭连接", async () => {
    let execCalls = 0;
    let closes = 0;
    const manager = new OperationManager({ idFactory: () => "profile-preflight" });
    const runner = new CommandRunner({ connect: async () => ({
      exec: () => { execCalls += 1; },
      close: () => { closes += 1; }
    }) }, manager);
    runner.start(host, "cat /tmp/link", undefined, async () => {
      throw codedError(ErrorCodes.POLICY_REQUIRES_APPROVAL);
    });

    await tick();
    expect(manager.get("profile-preflight")).toMatchObject({
      state: "failed", error: { code: "POLICY_REQUIRES_APPROVAL", sideEffects: "none" }
    });
    expect(execCalls).toBe(0);
    expect(closes).toBe(1);
  });

  it("立即返回 running，按原始字节追加输出，并将非零退出与 SSH 故障区分", async () => {
    const channel = new Channel();
    let command = "";
    const manager = new OperationManager({ idFactory: () => "cmd-1" });
    const runner = new CommandRunner({ connect: async () => ({
      exec: (value, callback) => { command = value; callback(undefined, channel); }, close: () => undefined
    }) }, manager);
    const started = runner.start(host, "printf 中文");
    expect(started).toMatchObject({ operationId: "cmd-1", state: "running" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(command).toBe("'/bin/sh' -lc 'printf 中文'");
    channel.emit("data", Buffer.from("ok\r\n"));
    channel.stderr.emit("data", Buffer.from([0xff]));
    channel.emit("close", 7, "TERM");
    expect(manager.get("cmd-1")).toMatchObject({
      state: "failed", error: { code: "COMMAND_FAILED" },
      result: { host: "linux", platform: "linux", exitCode: 7, signal: "TERM", stdoutBytes: 4, stderrBytes: 1 },
      frames: [{ stream: "stdout", encoding: "utf8", data: "ok\r\n" }, { stream: "stderr", encoding: "base64", data: "/w==" }]
    });
  });

  testWithIds(["SC-035"], "取消仅发送一次 TERM，并且远端 close 确认后才报告 cancelled", async () => {
    const channel = new Channel();
    const manager = new OperationManager({ idFactory: () => "cmd-2" });
    const runner = new CommandRunner({ connect: async () => ({ exec: (_value, callback) => callback(undefined, channel), close: () => undefined }) }, manager);
    runner.start(host, "sleep 10");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(manager.cancel("cmd-2").state).toBe("running");
    expect(manager.cancel("cmd-2").state).toBe("running");
    expect(channel.signals).toEqual(["TERM"]);
    channel.emit("close", undefined, "TERM");
    expect(manager.get("cmd-2").state).toBe("cancelled");
  });

  testWithIds(["SC-036"], "exec 已提交但 callback 延迟时，取消只能在强制关闭后收敛 unknown，迟到 close 不得误确认", async () => {
    const clock = new FakeClock();
    const channel = new Channel();
    let callback: ((error: Error | undefined, channel: Channel) => void) | undefined;
    let closeCalls = 0;
    const manager = new OperationManager({ clock, idFactory: () => "delayed-cancel" });
    const runner = new CommandRunner({ connect: async () => ({
      exec: (_value, received) => { callback = received as typeof callback; },
      close: () => { closeCalls += 1; }
    }) }, manager);
    runner.start(host, "sleep 10");
    await tick();
    manager.cancel("delayed-cancel");
    expect(manager.get("delayed-cancel").state).toBe("running");
    clock.advance(10_000);
    expect(manager.get("delayed-cancel")).toMatchObject({
      state: "unknown",
      error: { code: "CANCEL_UNCONFIRMED" },
      result: { host: "linux", platform: "linux", stdoutBytes: 0, stderrBytes: 0 }
    });
    callback!(undefined, channel);
    channel.emit("close", 0, "TERM");
    expect(manager.get("delayed-cancel").state).toBe("unknown");
    expect(closeCalls).toBeGreaterThan(0);
    expect(channel.signals).toEqual([]);
  });

  it("命令超时发生在延迟 exec callback 时保持 timeout unknown，不能伪造 timed_out", async () => {
    const clock = new FakeClock();
    const channel = new Channel();
    let callback: ((error: Error | undefined, channel: Channel) => void) | undefined;
    const manager = new OperationManager({ clock, idFactory: () => "delayed-timeout", limits: { commandTimeoutMs: 1 } });
    const runner = new CommandRunner({ connect: async () => ({
      exec: (_value, received) => { callback = received as typeof callback; }, close: () => undefined
    }) }, manager);
    runner.start(host, "sleep 10");
    await tick();
    clock.advance(1);
    clock.advance(10_000);
    expect(manager.get("delayed-timeout")).toMatchObject({
      state: "unknown",
      error: { code: "STATE_UNKNOWN", details: { reason: "timeout", timeoutKind: "command" } },
      result: { host: "linux", platform: "linux", stdoutBytes: 0, stderrBytes: 0 }
    });
    callback!(undefined, channel);
    channel.emit("exit", 0, "TERM");
    expect(manager.get("delayed-timeout").state).toBe("unknown");
  });

  it("停止期间 exec callback 返回错误也不能证明命令未执行，必须等待强制 unknown", async () => {
    const clock = new FakeClock();
    let callback: ((error: Error | undefined, channel: Channel) => void) | undefined;
    const manager = new OperationManager({ clock, idFactory: () => "stopping-exec-error" });
    const runner = new CommandRunner({ connect: async () => ({
      exec: (_value, received) => { callback = received as typeof callback; }, close: () => undefined
    }) }, manager);
    runner.start(host, "sleep 10");
    await tick();
    manager.cancel("stopping-exec-error");
    callback!(codedError(ErrorCodes.CONNECTION_REFUSED), undefined as never);
    expect(manager.get("stopping-exec-error").state).toBe("running");
    clock.advance(10_000);
    expect(manager.get("stopping-exec-error")).toMatchObject({ state: "unknown", error: { code: "CANCEL_UNCONFIRMED" } });
  });

  it("连接前取消不提交 exec，并写入可读取的终态结果", async () => {
    let resolveConnection: ((value: { exec: () => void; close: () => void }) => void) | undefined;
    let execCalls = 0;
    let closeCalls = 0;
    const manager = new OperationManager({ idFactory: () => "before-connect" });
    const runner = new CommandRunner({ connect: async () => await new Promise((resolve) => {
      resolveConnection = resolve as typeof resolveConnection;
    }) }, manager);
    runner.start(host, "echo should-not-run");
    await tick();
    expect(manager.cancel("before-connect")).toMatchObject({ state: "cancelled", result: { host: "linux", platform: "linux", stdoutBytes: 0, stderrBytes: 0 } });
    resolveConnection!({ exec: () => { execCalls += 1; }, close: () => { closeCalls += 1; } });
    await tick();
    expect(execCalls).toBe(0);
    expect(closeCalls).toBe(1);
  });

  testWithIds(["SC-056"], "七类操作错误均由真实组件路径产生并保留稳定分类与已有安全结果", async () => {
    const approval = await approvalDeclinedResult();
    expect(approval).toMatchObject({ approved: false, error: stableError(ErrorCodes.APPROVAL_DECLINED, "failed", "none") });

    const pathDenied = await directorySetupFailure("path");
    expect(pathDenied).toMatchObject({
      state: "failed", error: stableError(ErrorCodes.PATH_DENIED, "failed", "none"),
      result: { aggregateTransferredBytes: 0, completedItems: 0, succeeded: [], failed: [] }
    });

    const targetExists = await directorySetupFailure("target");
    expect(targetExists).toMatchObject({
      state: "failed", error: stableError(ErrorCodes.TARGET_EXISTS, "failed", "none"),
      result: { aggregateTransferredBytes: 0, completedItems: 0, succeeded: [], failed: [] }
    });

    const commandTimeout = await commandTimeoutResult();
    expect(commandTimeout).toMatchObject({
      state: "timed_out", error: stableError(ErrorCodes.COMMAND_TIMEOUT, "timed_out", "confirmed"),
      result: { stdoutBytes: 3, stderrBytes: 0 }
    });

    const sessionExpired = sessionExpiredResult();
    expect(sessionExpired).toMatchObject({
      error: stableError(ErrorCodes.SESSION_EXPIRED, "failed", "none"),
      lastSafeSnapshot: { sessionId: "expired-session", state: "disconnected" }
    });

    const transferFailed = await transferFailedResult();
    expect(transferFailed).toMatchObject({
      state: "failed", error: stableError(ErrorCodes.TRANSFER_FAILED, "failed", "none"),
      result: { transferredBytes: 0, completedItems: 0, finalTargetCommit: "not_committed" }
    });

    const partialFailure = await partialFailureResult();
    expect(partialFailure).toMatchObject({
      state: "partial_failure", error: stableError(ErrorCodes.PARTIAL_FAILURE, "partial_failure", "partial"),
      result: {
        aggregateTransferredBytes: 1, completedItems: 1, succeeded: ["a"],
        failed: [{ relativePath: "b", code: ErrorCodes.TRANSFER_FAILED, safety: "confirmed" }]
      }
    });
  });

  it("TERM 的远端确认将命令预算写为 COMMAND_TIMEOUT，且首个终态不可改写", async () => {
    const clock = new FakeClock();
    const channel = new Channel();
    const manager = new OperationManager({ clock, idFactory: () => "confirmed-timeout", limits: { commandTimeoutMs: 1 } });
    const runner = new CommandRunner({ connect: async () => ({
      exec: (_value, callback) => callback(undefined, channel), close: () => undefined
    }) }, manager);
    runner.start(host, "sleep 10");
    await tick();
    clock.advance(1);
    expect(channel.signals).toEqual(["TERM"]);
    channel.emit("close", 143, "TERM");
    expect(manager.get("confirmed-timeout")).toMatchObject({
      state: "timed_out", error: { code: "COMMAND_TIMEOUT", finalState: "timed_out", retriable: false, sideEffects: "confirmed" },
      result: { host: "linux", platform: "linux", exitCode: 143, signal: "TERM", stdoutBytes: 0, stderrBytes: 0 }
    });
    channel.emit("error", new Error("late"));
    expect(manager.get("confirmed-timeout").state).toBe("timed_out");
  });

  it("停止期间 null 退出码且没有信号的 Channel close 不能伪造远端确认", async () => {
    const clock = new FakeClock();
    const channel = new Channel();
    const manager = new OperationManager({ clock, idFactory: () => "stopping-missing-exit" });
    const runner = new CommandRunner({ connect: async () => ({
      exec: (_value, callback) => callback(undefined, channel), close: () => undefined
    }) }, manager);

    runner.start(host, "sleep 10");
    await tick();
    manager.cancel("stopping-missing-exit");
    channel.emit("close", null, undefined);
    expect(manager.get("stopping-missing-exit").state).toBe("running");

    clock.advance(10_000);
    expect(manager.get("stopping-missing-exit")).toMatchObject({
      state: "unknown",
      error: { code: "CANCEL_UNCONFIRMED", finalState: "unknown", sideEffects: "possible" },
      result: { host: "linux", platform: "linux", stdoutBytes: 0, stderrBytes: 0 }
    });
    expect(manager.get("stopping-missing-exit").result).not.toHaveProperty("exitCode");
  });

  testWithIds(["SC-057"], "执行中的 close 未携带退出信息时保留结果并报告状态未知", async () => {
    const channel = new Channel();
    const manager = new OperationManager({ idFactory: () => "missing-exit" });
    const runner = new CommandRunner({ connect: async () => ({
      exec: (_value, callback) => callback(undefined, channel), close: () => undefined
    }) }, manager);

    runner.start(host, "echo maybe-running");
    await tick();
    channel.emit("data", Buffer.from("partial"));
    channel.emit("close", undefined, undefined);

    expect(manager.get("missing-exit")).toMatchObject({
      state: "unknown",
      error: { code: "STATE_UNKNOWN", finalState: "unknown", retriable: false, sideEffects: "possible" },
      result: { host: "linux", platform: "linux", stdoutBytes: 7, stderrBytes: 0 }
    });
  });
});

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

async function tick(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }

function stableError(code: string, finalState: string, sideEffects: string) {
  return { code, finalState, retriable: false, sideEffects };
}

async function approvalDeclinedResult() {
  const service = new ApprovalService({
    supportsFormElicitation: () => true,
    elicit: async () => ({ action: "decline" as const })
  }, new FakeClock());
  const intent = createOperationIntent({
    kind: "raw_command", hosts: ["linux"], platformByHost: { linux: "linux" }, payload: { command: "echo never" }
  });
  return await service.execute(intent, () => { throw new Error("审批拒绝后不得执行副作用"); });
}

async function directorySetupFailure(kind: "path" | "target") {
  const manager = new OperationManager({ idFactory: () => `directory-${kind}` });
  const service = new DirectoryTransferService(manager, {
    prepare: async () => {
      if (kind === "path") {
        let ioCalls = 0;
        const guard = new LinuxPathGuard(["/safe"], {
          lstat: async () => { ioCalls += 1; return { kind: "directory", id: "safe" }; },
          realpath: async (path) => path
        });
        try { await guard.verify("/outside/denied"); } finally { expect(ioCalls).toBe(0); }
      } else {
        await new AtomicTarget("/safe/existing", false, "posix", atomicPort("file"), () => "exists").open();
      }
      throw new Error("不可达");
    }
  });
  const started = service.start(transferRequest(true));
  await waitForTerminal(manager, started.operationId);
  return manager.get(started.operationId);
}

async function commandTimeoutResult() {
  const clock = new FakeClock();
  const channel = new Channel();
  const manager = new OperationManager({ clock, idFactory: () => "sc-056-timeout", limits: { commandTimeoutMs: 1 } });
  const runner = new CommandRunner({ connect: async () => ({
    exec: (_value, callback) => callback(undefined, channel), close: () => undefined
  }) }, manager);
  const started = runner.start(host, "sleep 10");
  await tick();
  channel.emit("data", Buffer.from("abc"));
  clock.advance(1);
  channel.emit("close", 143, "TERM");
  return manager.get(started.operationId);
}

function sessionExpiredResult() {
  const clock = new FakeClock();
  const manager = new SessionManager({ clock, idFactory: () => "expired-session", retentionMs: 1 });
  manager.reserve({ host: "linux", platform: "linux", shell: "posix", columns: 80, rows: 24 });
  const channel = new Channel();
  manager.activate("expired-session", { close: () => undefined }, channel);
  channel.emit("close");
  const lastSafeSnapshot = manager.describe("expired-session");
  clock.advance(1);
  try {
    manager.get("expired-session");
    throw new Error("过期会话必须拒绝查询");
  } catch (error: unknown) {
    if (!(error instanceof SessionManagerError)) throw error;
    return { error: error.error, lastSafeSnapshot };
  }
}

async function transferFailedResult() {
  const manager = new OperationManager({ idFactory: () => "transfer-failed" });
  const service = new TransferService(manager, {
    prepare: async () => {
      await new AtomicTarget("/safe/target", false, "posix", atomicPort("absent", true), () => "failed-open").open();
      throw new Error("不可达");
    }
  });
  const started = service.start(transferRequest(false));
  await waitForTerminal(manager, started.operationId);
  return manager.get(started.operationId);
}

async function partialFailureResult() {
  const manager = new OperationManager({ idFactory: () => "directory-partial-sc-056" });
  const transfers = new Map<string, PreparedTransfer>([
    ["a", preparedTransfer(Buffer.from("a"), 1)],
    ["b", preparedTransfer(Buffer.from("bad"), 99)]
  ]);
  const directory: PreparedDirectoryTransfer = {
    entries: [
      { relativePath: "a", kind: "file", size: 1, id: "a" },
      { relativePath: "b", kind: "file", size: 99, id: "b" }
    ],
    createTargetRoot: async () => undefined,
    createDirectory: async () => undefined,
    prepareFile: async (entry) => transfers.get(entry.relativePath)!,
    close: async () => undefined
  };
  const service = new DirectoryTransferService(manager, { prepare: async () => directory });
  const started = service.start(transferRequest(true));
  await waitForTerminal(manager, started.operationId);
  return manager.get(started.operationId);
}

function atomicPort(status: "absent" | "file", failOpen = false): AtomicTargetPort {
  return {
    inspect: async () => status,
    supportsAtomicReplace: () => true,
    supportsNoReplace: () => true,
    openExclusive: async () => {
      if (failOpen) throw new Error("受控写入端打开失败");
      throw new Error("目标已存在时不得创建临时写入端");
    },
    commitNoReplace: async () => true,
    commitReplace: async () => true,
    remove: async () => undefined
  };
}

function preparedTransfer(source: Buffer, totalBytes: number): PreparedTransfer {
  return {
    source: Readable.from([source]), target: new PassThrough(), totalBytes,
    seal: async () => undefined, commit: async () => undefined,
    cleanup: async () => true, close: async () => undefined
  };
}

function transferRequest(recursive: boolean): TransferRequest {
  return {
    direction: "upload", host, source: "/local/source", target: "/safe/target", overwrite: false, recursive
  };
}

async function waitForTerminal(manager: OperationManager, operationId: string): Promise<void> {
  const terminal = new Set(["completed", "failed", "partial_failure", "timed_out", "cancelled", "unknown"]);
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (terminal.has(manager.get(operationId).state)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("等待操作终态超时");
}
