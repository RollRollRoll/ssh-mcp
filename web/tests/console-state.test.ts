import { afterEach, describe, expect, it, vi } from "vitest";
import { createConsoleClient } from "../src/console-client";
import { consoleReducer, initialConsoleState, writesEnabled } from "../src/console-state";
import type { RuntimeSnapshot } from "../src/console-types";
import { testWithIds } from "../../tests/test-with-ids.js";

describe("控制台状态归约", () => {
  afterEach(() => vi.unstubAllGlobals());

  testWithIds(["LC-SC-041", "LC-SC-043"], "用完整权威快照替换状态，并忽略迟到的旧修订", () => {
    const current = consoleReducer(initialConsoleState, { type: "snapshot", snapshot: snapshot(4, "new") });
    const stale = consoleReducer(current, { type: "snapshot", snapshot: snapshot(3, "old") });
    expect(stale).toBe(current);
    expect(stale.snapshot?.hosts[0]?.alias).toBe("new");

    const replacement = consoleReducer(stale, { type: "snapshot", snapshot: snapshot(5, "replacement") });
    expect(replacement.snapshot?.hosts.map((host) => host.alias)).toEqual(["replacement"]);
    expect(replacement.connection).toBe("online");
  });

  it("连接、同步或退出状态都禁用写能力", () => {
    expect(writesEnabled(initialConsoleState)).toBe(false);
    const online = consoleReducer(initialConsoleState, { type: "snapshot", snapshot: snapshot(1, "host") });
    expect(writesEnabled(online)).toBe(true);
    expect(writesEnabled(consoleReducer(online, { type: "syncing" }))).toBe(false);
    expect(writesEnabled(consoleReducer(online, { type: "disconnected" }))).toBe(false);
    expect(writesEnabled(consoleReducer(online, {
      type: "snapshot", snapshot: { ...snapshot(2, "host"), serviceState: "quiescing" }
    }))).toBe(false);
  });

  it("沿 nextCursor 合并长输出分片", () => {
    let state = consoleReducer(initialConsoleState, { type: "snapshot", snapshot: snapshot(1, "host") });
    state = consoleReducer(state, { type: "select-operation", operationId: "operation-1" });
    state = consoleReducer(state, {
      type: "output", operationId: "operation-1", requestedCursor: 0,
      output: { frames: [{ stream: "stdout", cursor: 0, encoding: "utf8", data: "one" }], nextCursor: 3, minCursor: 0, truncated: false, droppedBytes: 0 }
    });
    state = consoleReducer(state, {
      type: "output", operationId: "operation-1", requestedCursor: 3,
      output: { frames: [{ stream: "stderr", cursor: 3, encoding: "utf8", data: "two" }], nextCursor: 6, minCursor: 0, truncated: false, droppedBytes: 0 }
    });
    expect(state.output?.frames.map((frame) => frame.data)).toEqual(["one", "two"]);
    expect(state.output?.nextCursor).toBe(6);
  });

  testWithIds(["LC-SC-040", "LC-AC-007"], "SSE ready/失效自动拉取权威快照，并合并并发刷新", async () => {
    const source = new FakeEventSource();
    vi.stubGlobal("EventSource", class { public constructor() { return source; } });
    let resolveSecond!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(snapshot(1, "first")))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveSecond = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const actions: unknown[] = [];
    const client = createConsoleClient((action) => actions.push(action));

    source.emit("ready");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(actions).toContainEqual({ type: "snapshot", snapshot: snapshot(1, "first") }));
    source.emit("invalidated");
    source.emit("invalidated");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolveSecond(response(snapshot(2, "second")));
    await vi.waitFor(() => expect(actions).toContainEqual({ type: "snapshot", snapshot: snapshot(2, "second") }));

    source.fail();
    expect(actions.at(-1)).toEqual({ type: "disconnected" });
    client.close();
    expect(source.closed).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/snapshot", {
      credentials: "same-origin", headers: { accept: "application/json" }
    });
  });
});

class FakeEventSource {
  public onerror: (() => void) | null = null;
  public closed = false;
  private readonly listeners = new Map<string, Array<() => void>>();
  public addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  public emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
  public fail(): void { this.onerror?.(); }
  public close(): void { this.closed = true; }
}

function response(value: unknown): Response {
  return { ok: true, status: 200, json: async () => value } as Response;
}

function snapshot(revision: number, alias: string): RuntimeSnapshot {
  return {
    instanceId: "instance", revision, serviceState: "active",
    hosts: [{ alias, environment: "development", platform: "linux", shell: "posix", connectionState: "unknown" }],
    operations: [{
      operationId: "operation-1", source: "mcp", kind: "command", hosts: [alias], state: "running",
      cancelRequested: false, lastStateChangeAt: 0, outputTruncated: false, progress: {}
    }],
    sessions: [], approvals: [], profiles: []
  };
}
