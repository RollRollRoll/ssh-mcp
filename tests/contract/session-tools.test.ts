import { EventEmitter } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createOperationIntent, type OperationIntent } from "../../src/approval/operation-intent.js";
import type { HostConfig } from "../../src/config/schema.js";
import { HostRegistry } from "../../src/hosts/host-registry.js";
import { OperationManager } from "../../src/operations/operation-manager.js";
import { SessionManager } from "../../src/sessions/session-manager.js";
import { createServer } from "../../src/server.js";

const host: HostConfig = {
  alias: "linux", environment: "test", platform: "linux", host: "127.0.0.1", port: 22, username: "tester",
  auth: { type: "privateKeyFile", path: "/tmp/key" }, shell: { type: "posix", command: "/bin/sh" }, remoteRoots: ["/tmp"]
};

class Channel extends EventEmitter {
  public readonly stderr = new EventEmitter();
  public readonly writes: Buffer[] = [];
  public readonly windows: Array<[number, number, number, number]> = [];
  public closes = 0;
  public write(data: Buffer, callback?: (error?: Error | null) => void): boolean { this.writes.push(Buffer.from(data)); callback?.(); return true; }
  public setWindow(rows: number, columns: number, height: number, width: number): void { this.windows.push([rows, columns, height, width]); }
  public close(): void { this.closes += 1; }
}

class Clock {
  private id = 0;
  private readonly timers = new Map<number, () => void>();
  public setTimeout(callback: () => void): number { const id = ++this.id; this.timers.set(id, callback); return id; }
  public clearTimeout(timer: unknown): void { this.timers.delete(timer as number); }
  public fireAll(): void { for (const [id, callback] of [...this.timers]) { this.timers.delete(id); callback(); } }
}

describe("session MCP 工具契约", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { await Promise.all(closers.splice(0).map(async (close) => await close())); });

  it("严格拒绝动态字段、未知主机与非规范 base64，且不会审批或连接", async () => {
    let approvals = 0;
    let connections = 0;
    const { client } = await connect({ execute: async () => { approvals += 1; throw new Error("不应审批"); } }, () => { connections += 1; });
    await expect(client.callTool({ name: "session_open", arguments: { host: "missing", columns: 80, rows: 24 } })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "HOST_NOT_REGISTERED" } } });
    await expect(client.callTool({ name: "session_open", arguments: { host: "linux", columns: 80, rows: 24, shell: "/bin/sh" } })).resolves.toMatchObject({ isError: true });
    await expect(client.callTool({ name: "session_write", arguments: { sessionId: "never", data: { encoding: "base64", value: "YQ" } } })).resolves.toMatchObject({ isError: true });
    expect(approvals).toBe(0);
    expect(connections).toBe(0);
  });

  it("打开只在获批 Intent 中创建独占 PTY，读写尺寸均精确绑定并保持 raw 字节", async () => {
    const channel = new Channel();
    const intents: OperationIntent[] = [];
    const { client, connections } = await connect({
      execute: async <T>(intent: OperationIntent, sideEffect: (value: OperationIntent) => T | Promise<T>) => {
        intents.push(intent);
        return { approved: true as const, intent, value: await sideEffect(intent) };
      }
    }, () => ({ channel }));
    const opened = await client.callTool({ name: "session_open", arguments: { host: "linux", columns: 101, rows: 42 } });
    expect(opened).toMatchObject({
      structuredContent: { session: { sessionId: "session-1", state: "active", columns: 101, rows: 42, shell: "posix", cursor: 0 } }
    });
    expect(connections()).toBe(1);
    expect(intents[0]?.kind).toBe("session_open");
    expect(intents[0]?.payload).toMatchObject({ columns: 101, rows: 42, shell: "posix" });

    const written = await client.callTool({ name: "session_write", arguments: { sessionId: "session-1", data: { encoding: "base64", value: "AMOK" } } });
    const resized = await client.callTool({ name: "session_resize", arguments: { sessionId: "session-1", columns: 120, rows: 50 } });
    expect(written).toMatchObject({ structuredContent: { session: { state: "active" } } });
    expect(resized).toMatchObject({ structuredContent: { session: { columns: 120, rows: 50 } } });
    expect((written.structuredContent as { session: object }).session).not.toHaveProperty("cursor");
    expect((resized.structuredContent as { session: object }).session).not.toHaveProperty("cursor");
    expect(channel.writes).toEqual([Buffer.from([0, 0xc3, 0x8a])]);
    expect(channel.windows).toEqual([[50, 120, 0, 0]]);
    expect(intents.slice(1).map((intent) => intent.kind)).toEqual(["session_input", "session_resize"]);
    expect(intents[1]?.payload).toMatchObject({ sessionId: "session-1", data: { encoding: "base64", value: "AMOK" } });
    channel.emit("data", Buffer.from("中文"));
    await expect(client.callTool({ name: "session_read", arguments: { sessionId: "session-1", cursor: 0, maxBytes: 32 } })).resolves.toMatchObject({
      structuredContent: { frames: [{ stream: "pty", seq: 0, cursor: 0, byteLength: 6, encoding: "utf8", data: "中文" }], nextCursor: 6 }
    });
  });

  it("审批拒绝不写入；close 无审批且已 closing 会话拒绝后续写入", async () => {
    const channel = new Channel();
    let calls = 0;
    const { client } = await connect({
      execute: async <T>(intent: OperationIntent, sideEffect: (value: OperationIntent) => T | Promise<T>) => {
        calls += 1;
        if (intent.kind === "session_input") return { approved: false as const, error: { code: "APPROVAL_DECLINED", message: "x", finalState: "failed" as const, retriable: false, sideEffects: "none" as const } };
        return { approved: true as const, intent, value: await sideEffect(intent) };
      }
    }, () => ({ channel }));
    await client.callTool({ name: "session_open", arguments: { host: "linux", columns: 80, rows: 24 } });
    await expect(client.callTool({ name: "session_write", arguments: { sessionId: "session-1", data: { encoding: "utf8", value: "x" } } })).resolves.toMatchObject({ isError: true, structuredContent: { session: { state: "active" }, error: { code: "APPROVAL_DECLINED" } } });
    expect(channel.writes).toEqual([]);
    await expect(client.callTool({ name: "session_close", arguments: { sessionId: "session-1" } })).resolves.toMatchObject({ structuredContent: { session: { state: "closing" } } });
    expect(calls).toBe(2);
    await expect(client.callTool({ name: "session_write", arguments: { sessionId: "session-1", data: { encoding: "utf8", value: "late" } } })).resolves.toMatchObject({ isError: true, structuredContent: { session: { state: "closing" }, error: { code: "SESSION_NOT_ACTIVE" } } });
  });

  it.each([
    { tool: "session_write", arguments: { sessionId: "session-1", data: { encoding: "utf8", value: "late" } }, code: "APPROVAL_DECLINED" },
    { tool: "session_resize", arguments: { sessionId: "session-1", columns: 120, rows: 50 }, code: "APPROVAL_TIMEOUT" }
  ])("$tool 审批等待期间关闭后，审批失败返回最新安全快照", async ({ tool, arguments: input, code }) => {
    let release!: (value: unknown) => void;
    const { client } = await connect({
      execute: async <T>(intent: OperationIntent, sideEffect: (value: OperationIntent) => T | Promise<T>) => {
        if (intent.kind === "session_open") return { approved: true as const, intent, value: await sideEffect(intent) };
        return await new Promise((resolve) => { release = resolve; });
      }
    }, () => ({ channel: new Channel() }));
    await client.callTool({ name: "session_open", arguments: { host: "linux", columns: 80, rows: 24 } });
    const pending = client.callTool({ name: tool, arguments: input });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await client.callTool({ name: "session_close", arguments: { sessionId: "session-1" } });
    release({ approved: false, error: { code, message: code, finalState: code === "APPROVAL_TIMEOUT" ? "timed_out" : "failed", retriable: false, sideEffects: "none" } });
    await expect(pending).resolves.toMatchObject({ isError: true, structuredContent: { session: { state: "closing" }, error: { code } } });
  });

  it("错配目标或数据的已批准 session_write Intent 返回稳定错误且零写入", async () => {
    const channel = new Channel();
    let attempt = 0;
    const { client } = await connect({
      execute: async <T>(intent: OperationIntent, sideEffect: (value: OperationIntent) => T | Promise<T>) => {
        if (intent.kind === "session_open") return { approved: true as const, intent, value: await sideEffect(intent) };
        attempt += 1;
        const mismatched = createOperationIntent({
          kind: "session_input", hosts: ["linux"], platformByHost: { linux: "linux" },
          payload: attempt === 1
            ? { sessionId: "session-1", data: { encoding: "utf8", value: "different-data" } }
            : { sessionId: "another-session", data: { encoding: "utf8", value: "original" } }
        });
        return { approved: true as const, intent: mismatched, value: await sideEffect(mismatched) };
      }
    }, () => ({ channel }));
    await client.callTool({ name: "session_open", arguments: { host: "linux", columns: 80, rows: 24 } });
    await expect(client.callTool({ name: "session_write", arguments: { sessionId: "session-1", data: { encoding: "utf8", value: "original" } } })).resolves.toMatchObject({
      isError: true, structuredContent: { session: { state: "active" }, error: { code: "APPROVAL_INTENT_MISMATCH", sideEffects: "none" } }
    });
    await expect(client.callTool({ name: "session_write", arguments: { sessionId: "session-1", data: { encoding: "utf8", value: "original" } } })).resolves.toMatchObject({
      isError: true, structuredContent: { session: { state: "active" }, error: { code: "APPROVAL_INTENT_MISMATCH", sideEffects: "none" } }
    });
    expect(channel.writes).toEqual([]);
  });

  it("PTY 打开超时或连接关闭会清理 opening 配额；迟到通道不会被激活", async () => {
    const clock = new Clock();
    const channel = new Channel();
    let callback: ((error: Error | undefined, value: Channel) => void) | undefined;
    let closes = 0;
    const { client } = await connect({ execute: async <T>(intent: OperationIntent, sideEffect: (value: OperationIntent) => T | Promise<T>) => ({ approved: true as const, intent, value: await sideEffect(intent) }) },
      (openCallback) => { callback = openCallback; return { close: () => { closes += 1; } }; }, clock);
    const pending = client.callTool({ name: "session_open", arguments: { host: "linux", columns: 80, rows: 24 } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    clock.fireAll();
    await expect(pending).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "STATE_UNKNOWN", sideEffects: "possible" } } });
    expect(closes).toBe(1);
    callback?.(undefined, channel);
    expect(channel.closes).toBe(1);
    const retry = client.callTool({ name: "session_open", arguments: { host: "linux", columns: 80, rows: 24 } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    clock.fireAll();
    await expect(retry).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "STATE_UNKNOWN" } } });
  });

  it("打开期间的 SSH 连接关闭优先结算，且不遗留 opening 记录", async () => {
    const clock = new Clock();
    let closed: (() => void) | undefined;
    const { client } = await connect({ execute: async <T>(intent: OperationIntent, sideEffect: (value: OperationIntent) => T | Promise<T>) => ({ approved: true as const, intent, value: await sideEffect(intent) }) },
      () => ({ onClose: (listener) => { closed = listener; } }), clock);
    const pending = client.callTool({ name: "session_open", arguments: { host: "linux", columns: 80, rows: 24 } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    closed?.();
    await expect(pending).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "STATE_UNKNOWN" } } });
  });

  async function connect(
    approval: { execute: <T>(intent: OperationIntent, sideEffect: (intent: OperationIntent) => T | Promise<T>) => Promise<unknown> },
    open: (callback: (error: Error | undefined, value: Channel) => void) => { channel?: Channel; close?: () => void; onClose?: (listener: () => void) => void },
    clock?: Clock
  ): Promise<{ client: Client; connections: () => number }> {
    let connectionCount = 0;
    const registry = new HostRegistry([host]);
    const sessions = new SessionManager({ idFactory: () => "session-1" });
    const server = createServer(registry, new OperationManager(), undefined, undefined, {
      registry, approval: approval as never, sessions,
      clock,
      adapter: { connect: async () => {
        connectionCount += 1;
        let close = () => undefined;
        let registerClose: ((listener: () => void) => void) | undefined;
        let pendingCloseListener: (() => void) | undefined;
        return {
          openShell: (_columns, _rows, _shellCommand, callback) => {
            const result = open(callback as (error: Error | undefined, value: Channel) => void);
            close = result.close ?? close;
            registerClose = result.onClose;
            if (pendingCloseListener !== undefined) registerClose?.(pendingCloseListener);
            if (result.channel !== undefined) callback(undefined, result.channel as never);
          },
          close: () => close(),
          onClose: (listener: () => void) => {
            pendingCloseListener = listener;
            registerClose?.(listener);
          },
          exec: () => undefined
        };
      } }
    });
    const client = new Client({ name: "contract-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closers.push(async () => { await client.close(); await server.close(); });
    return { client, connections: () => connectionCount };
  }
});
