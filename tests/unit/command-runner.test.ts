import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { HostConfig } from "../../src/config/schema.js";
import { CommandRunner } from "../../src/commands/command-runner.js";
import { ErrorCodes } from "../../src/errors/error-codes.js";
import { OperationManager, type MonotonicClock } from "../../src/operations/operation-manager.js";

class Channel extends EventEmitter {
  public readonly stderr = new EventEmitter();
  public signals: string[] = [];
  public signal(value: string): void { this.signals.push(value); }
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

  it("取消仅发送一次 TERM，并且远端 close 确认后才报告 cancelled", async () => {
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

  it("exec 已提交但 callback 延迟时，取消只能在强制关闭后收敛 unknown，迟到 close 不得误确认", async () => {
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

  it("连接与 exec callback 失败均保留稳定错误码和最小结果", async () => {
    const connectManager = new OperationManager({ idFactory: () => "connect-error" });
    const connectRunner = new CommandRunner({ connect: async () => { throw codedError(ErrorCodes.CONNECTION_TIMEOUT); } }, connectManager);
    connectRunner.start(host, "echo never");
    await tick();
    expect(connectManager.get("connect-error")).toMatchObject({
      state: "failed", error: { code: "CONNECTION_TIMEOUT", sideEffects: "none" },
      result: { host: "linux", platform: "linux", stdoutBytes: 0, stderrBytes: 0 }
    });

    const execManager = new OperationManager({ idFactory: () => "exec-error" });
    const execRunner = new CommandRunner({ connect: async () => ({
      exec: (_value, callback) => callback(codedError(ErrorCodes.CONNECTION_REFUSED), undefined as never), close: () => undefined
    }) }, execManager);
    execRunner.start(host, "echo never");
    await tick();
    expect(execManager.get("exec-error")).toMatchObject({
      state: "failed", error: { code: "CONNECTION_REFUSED", sideEffects: "none" },
      result: { host: "linux", platform: "linux", stdoutBytes: 0, stderrBytes: 0 }
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

  it("执行中的 close 未携带退出信息时保留结果并报告状态未知", async () => {
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
