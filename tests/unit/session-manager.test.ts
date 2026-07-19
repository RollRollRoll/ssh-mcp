import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { ErrorCodes } from "../../src/errors/error-codes.js";
import { OperationManager } from "../../src/operations/operation-manager.js";
import { SessionManager, type SessionClock } from "../../src/sessions/session-manager.js";
import { testWithIds } from "../test-with-ids.js";

class Clock implements SessionClock {
  public nowMs = 0;
  private sequence = 0;
  private readonly timers = new Map<number, { due: number; callback: () => void }>();
  public now(): number { return this.nowMs; }
  public setTimeout(callback: () => void, delayMs: number): number { const id = ++this.sequence; this.timers.set(id, { due: this.nowMs + delayMs, callback }); return id; }
  public clearTimeout(timer: unknown): void { this.timers.delete(timer as number); }
  public advance(ms: number): void {
    this.nowMs += ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, item]) => item.due <= this.nowMs);
      if (due.length === 0) return;
      for (const [id, item] of due) { this.timers.delete(id); item.callback(); }
    }
  }
}

class Channel extends EventEmitter {
  public readonly stderr = new EventEmitter();
  public writes: Buffer[] = [];
  public windows: Array<[number, number, number, number]> = [];
  public closes = 0;
  public write(data: Buffer, callback?: (error?: Error | null) => void): boolean { this.writes.push(Buffer.from(data)); callback?.(); return true; }
  public setWindow(rows: number, columns: number, height: number, width: number): void { this.windows.push([rows, columns, height, width]); }
  public close(): void { this.closes += 1; }
}

function reserve(manager: SessionManager, id = "s-1") {
  const snapshot = manager.reserve({ host: "linux", platform: "linux", shell: "posix", columns: 80, rows: 24 });
  expect(snapshot.sessionId).toBe(id);
  return snapshot;
}

describe("SessionManager", () => {
  it("opening 占用资源，激活后独立保存 PTY 原始字节与尺寸", () => {
    const manager = new SessionManager({ idFactory: () => "s-1", maxSessions: 1 });
    reserve(manager);
    expectError(() => manager.reserve({ host: "two", platform: "linux", shell: "posix", columns: 1, rows: 1 }), ErrorCodes.RESOURCE_LIMIT);
    const channel = new Channel();
    manager.activate("s-1", { close: () => undefined }, channel);
    channel.emit("data", Buffer.from("中文"));
    channel.stderr.emit("data", Buffer.from([0xff]));
    expect(manager.resize("s-1", 120, 40)).toMatchObject({ columns: 120, rows: 40 });
    expect(channel.windows).toEqual([[40, 120, 0, 0]]);
    expect(manager.get("s-1")).toMatchObject({
      state: "active", frames: [
        { stream: "pty", encoding: "utf8", data: "中文" },
        { stream: "pty", encoding: "base64", data: "/w==" }
      ]
    });
  });

  it("输入队列将审批等待也串行化，关闭后已排队动作不写入", async () => {
    const manager = new SessionManager({ idFactory: () => "s-1" });
    reserve(manager);
    const channel = new Channel();
    manager.activate("s-1", { close: () => undefined }, channel);
    let release!: () => void;
    const first = manager.enqueueInput("s-1", async () => await new Promise<void>((resolve) => { release = resolve; }));
    const second = manager.enqueueInput("s-1", () => manager.write("s-1", Buffer.from("late")));
    await new Promise<void>((resolve) => setImmediate(resolve));
    manager.close("s-1");
    release();
    await first;
    await expect(second).rejects.toMatchObject({ error: { code: ErrorCodes.SESSION_NOT_ACTIVE } });
    expect(channel.writes).toEqual([]);
  });

  it("空闲先进入 closing；真实 close 才为 closed，强制关闭保持 unknown 且迟到事件不可改写", () => {
    const clock = new Clock();
    const connection = { closes: 0, close() { this.closes += 1; } };
    const manager = new SessionManager({ clock, idFactory: () => "s-1", idleTimeoutMs: 1, closeConfirmationTimeoutMs: 10 });
    reserve(manager);
    const channel = new Channel();
    manager.activate("s-1", connection, channel);
    clock.advance(1);
    expect(manager.get("s-1").state).toBe("closing");
    expect(channel.closes).toBe(1);
    clock.advance(10);
    expect(manager.get("s-1").state).toBe("unknown");
    channel.emit("close");
    channel.emit("exit");
    expect(manager.get("s-1").state).toBe("unknown");
    expect(connection.closes).toBe(1);
    expect(channel.closes).toBe(1);
  });

  testWithIds(["SC-032"], "远端主动 close 标记 disconnected；关闭记录保留后明确过期", async () => {
    const clock = new Clock();
    const manager = new SessionManager({ clock, idFactory: () => "s-1", retentionMs: 5 });
    reserve(manager);
    const channel = new Channel();
    manager.activate("s-1", { close: () => undefined }, channel);
    channel.emit("close");
    expect(manager.get("s-1").state).toBe("disconnected");
    await expect(manager.write("s-1", Buffer.from("x"))).rejects.toMatchObject({ error: { code: ErrorCodes.SESSION_DISCONNECTED } });
    clock.advance(5);
    expectError(() => manager.get("s-1"), ErrorCodes.SESSION_EXPIRED);
  });

  testWithIds(["MN-012"], "新服务生命周期不恢复旧会话或任务，旧 ID 明确 NOT_FOUND 且零重放", async () => {
    let oldOperationCancels = 0;
    const oldOperations = new OperationManager({ idFactory: () => "old-operation" });
    oldOperations.create({ initialState: "running", runner: { cancel: () => { oldOperationCancels += 1; } } });
    const oldSessions = new SessionManager({ idFactory: () => "old-session" });
    reserve(oldSessions, "old-session");
    const oldChannel = new Channel();
    let oldConnectionCloses = 0;
    oldSessions.activate("old-session", { close: () => { oldConnectionCloses += 1; } }, oldChannel);

    const freshOperations = new OperationManager({ idFactory: () => "fresh-operation" });
    const freshSessions = new SessionManager({ idFactory: () => "fresh-session" });
    expectOperationError(() => freshOperations.get("old-operation"), ErrorCodes.OPERATION_NOT_FOUND);
    expectOperationError(() => freshOperations.cancel("old-operation"), ErrorCodes.OPERATION_NOT_FOUND);
    expectError(() => freshSessions.get("old-session"), ErrorCodes.SESSION_NOT_FOUND);
    await expect(freshSessions.write("old-session", Buffer.from("不得重放")))
      .rejects.toMatchObject({ error: { code: ErrorCodes.SESSION_NOT_FOUND } });
    expectError(() => freshSessions.resize("old-session", 100, 40), ErrorCodes.SESSION_NOT_FOUND);
    expectError(() => freshSessions.close("old-session"), ErrorCodes.SESSION_NOT_FOUND);

    expect(oldOperationCancels).toBe(0);
    expect(oldChannel.writes).toEqual([]);
    expect(oldChannel.closes).toBe(0);
    expect(oldConnectionCloses).toBe(0);
  });

  it("打开失败会移除预留会话且不会污染查询空间", () => {
    const manager = new SessionManager({ idFactory: () => "s-1" });
    reserve(manager);
    manager.abandonOpening("s-1");
    expectError(() => manager.get("s-1"), ErrorCodes.SESSION_NOT_FOUND);
  });

  testWithIds(["SC-029"], "小帧超过输出容量时序号元数据随帧淘汰，截断后的 seq 仍稳定", () => {
    const manager = new SessionManager({ idFactory: () => "s-1", outputBufferBytes: 3 });
    reserve(manager);
    const channel = new Channel();
    manager.activate("s-1", { close: () => undefined }, channel);
    for (const value of ["0", "1", "2", "3", "4"]) channel.emit("data", Buffer.from(value));
    const read = manager.get("s-1", 0, 16);
    expect(read).toMatchObject({ minCursor: 2, truncated: true, frames: [
      { cursor: 2, seq: 2, data: "2" }, { cursor: 3, seq: 3, data: "3" }, { cursor: 4, seq: 4, data: "4" }
    ] });
    expect(read.frames).toHaveLength(3);
  });

  it("写入等待本地接受；背压 drain、异步 error 与 close 都只 settle 一次", async () => {
    const manager = new SessionManager({ idFactory: () => "s-1" });
    reserve(manager);
    const channel = new Channel();
    manager.activate("s-1", { close: () => undefined }, channel);
    channel.write = ((data: Buffer) => { channel.writes.push(Buffer.from(data)); return false; }) as Channel["write"];
    const drained = manager.write("s-1", Buffer.from("a"));
    channel.emit("drain");
    await expect(drained).resolves.toMatchObject({ state: "active" });

    channel.write = ((data: Buffer) => {
      channel.writes.push(Buffer.from(data));
      queueMicrotask(() => channel.emit("error", new Error("broken")));
      return true;
    }) as Channel["write"];
    await expect(manager.write("s-1", Buffer.from("b"))).rejects.toMatchObject({ error: { code: ErrorCodes.STATE_UNKNOWN, sideEffects: "possible" }, session: { state: "unknown" } });
    expect(manager.get("s-1").state).toBe("unknown");
  });

  it("挂起写入在关闭或断连后有界结算，FIFO 不死锁且监听器全部清理", async () => {
    const manager = new SessionManager({ idFactory: () => "s-1" });
    reserve(manager);
    const channel = new Channel();
    manager.activate("s-1", { close: () => undefined }, channel);
    channel.write = ((data: Buffer) => { channel.writes.push(Buffer.from(data)); return false; }) as Channel["write"];
    const first = manager.enqueueInput("s-1", () => manager.write("s-1", Buffer.from("pending")));
    const second = manager.enqueueInput("s-1", () => manager.resize("s-1", 90, 30));
    await new Promise<void>((resolve) => setImmediate(resolve));
    manager.close("s-1");
    const [firstResult, secondResult] = await Promise.allSettled([first, second]);
    expect(firstResult).toMatchObject({ status: "rejected", reason: { error: { code: ErrorCodes.STATE_UNKNOWN, sideEffects: "possible" } } });
    expect(secondResult).toMatchObject({ status: "rejected", reason: { error: { code: ErrorCodes.SESSION_NOT_ACTIVE } } });
    expect(channel.listenerCount("error")).toBe(1);
    expect(channel.listenerCount("close")).toBe(1);
    expect(channel.listenerCount("drain")).toBe(0);

    const disconnected = new SessionManager({ idFactory: () => "s-2" });
    reserve(disconnected, "s-2");
    const other = new Channel();
    disconnected.activate("s-2", { close: () => undefined }, other);
    other.write = (() => false) as Channel["write"];
    const pending = disconnected.write("s-2", Buffer.from("pending"));
    other.emit("close");
    await expect(pending).rejects.toMatchObject({ error: { code: ErrorCodes.STATE_UNKNOWN }, session: { state: "disconnected" } });
    expect(other.listenerCount("drain")).toBe(0);
  });

  it("同步 write callback 结算且返回 false 时不遗留 drain 监听器", async () => {
    const manager = new SessionManager({ idFactory: () => "s-1" });
    reserve(manager);
    const channel = new Channel();
    manager.activate("s-1", { close: () => undefined }, channel);
    channel.write = ((_data: Buffer, callback?: (error?: Error | null) => void) => { callback?.(); return false; }) as Channel["write"];
    await expect(manager.write("s-1", Buffer.from("accepted"))).resolves.toMatchObject({ state: "active" });
    expect(channel.listenerCount("drain")).toBe(0);
  });

  testWithIds(["SC-031"], "同步 close 不遗留确认计时器，终态释放资源且迟到事件不可改写", () => {
    const clock = new Clock();
    const connection = { closes: 0, close() { this.closes += 1; } };
    const manager = new SessionManager({ clock, idFactory: () => "s-1", closeConfirmationTimeoutMs: 10 });
    reserve(manager);
    const channel = new Channel();
    channel.close = () => { channel.closes += 1; channel.emit("close"); };
    manager.activate("s-1", connection, channel);
    expect(manager.close("s-1").state).toBe("closed");
    expect(manager.close("s-1").state).toBe("closed");
    clock.advance(10);
    channel.emit("exit");
    expect(manager.get("s-1").state).toBe("closed");
    expect(channel.closes).toBe(1);
    expect(connection.closes).toBe(1);
  });
});

function expectError(action: () => unknown, code: string): void {
  try { action(); } catch (error: unknown) {
    expect(error).toMatchObject({ error: { code } });
    return;
  }
  throw new Error(`预期错误 ${code}`);
}

function expectOperationError(action: () => unknown, code: string): void {
  try { action(); } catch (error: unknown) {
    expect(error).toMatchObject({ error: { code } });
    return;
  }
  throw new Error(`预期操作错误 ${code}`);
}
