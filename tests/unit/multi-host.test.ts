import { describe, expect, it } from "vitest";
import type { HostConfig } from "../../src/config/schema.js";
import { MultiHostCoordinator } from "../../src/multihost/multi-host-coordinator.js";
import { OperationManager, type MonotonicClock, type OperationSnapshot } from "../../src/operations/operation-manager.js";

const hosts = Array.from({ length: 11 }, (_value, index) => host(`host-${index + 1}`));

describe("MultiHostCoordinator", () => {
  it("2 台并行成功时保留独立结果并聚合为 completed", async () => {
    const { manager, coordinator, start } = harness({ "host-1": "completed", "host-2": "completed" });
    const outer = coordinator.start(options(hosts.slice(0, 2), "parallel", start));

    const result = await terminal(manager, outer.operationId);
    expect(result).toMatchObject({
      state: "completed",
      result: { executionMode: "parallel", hosts: [
        { host: "host-1", state: "completed", result: { host: "host-1" } },
        { host: "host-2", state: "completed", result: { host: "host-2" } }
      ] }
    });
  });

  it("sequential 严格等待前一台终态后才启动下一台", async () => {
    const manager = new OperationManager({ idFactory: sequence("outer", "one", "two") });
    const coordinator = new MultiHostCoordinator(manager);
    const started: string[] = [];
    let firstId = "";
    const start = (target: HostConfig): OperationSnapshot => {
      started.push(target.alias);
      const snapshot = manager.create({ initialState: "running", runner: { cancel: () => undefined }, timeoutKind: "command" });
      if (target.alias === "host-1") firstId = snapshot.operationId;
      else queueMicrotask(() => manager.complete(snapshot.operationId, { host: target.alias }));
      return snapshot;
    };

    const outer = coordinator.start(options(hosts.slice(0, 2), "sequential", start));
    await tick();
    expect(started).toEqual(["host-1"]);
    manager.complete(firstId, { host: "host-1" });

    await expect(terminal(manager, outer.operationId)).resolves.toMatchObject({ state: "completed" });
    expect(started).toEqual(["host-1", "host-2"]);
  });

  it("一台失败仍收集已启动主机，整体为 partial_failure", async () => {
    const { manager, coordinator, start } = harness({ "host-1": "failed", "host-2": "completed" });
    const outer = coordinator.start(options(hosts.slice(0, 2), "parallel", start));

    await expect(terminal(manager, outer.operationId)).resolves.toMatchObject({
      state: "partial_failure",
      result: { hosts: [{ host: "host-1", state: "failed" }, { host: "host-2", state: "completed" }] }
    });
  });

  it("取消 sequential 时不启动剩余主机，并保留已取消项", async () => {
    const manager = new OperationManager({ idFactory: sequence("outer", "one") });
    const coordinator = new MultiHostCoordinator(manager);
    const started: string[] = [];
    const start = (target: HostConfig): OperationSnapshot => {
      started.push(target.alias);
      let operationId = "";
      const snapshot = manager.create({
        initialState: "running",
        timeoutKind: "command",
        runner: { cancel: () => queueMicrotask(() => manager.confirmStopped(operationId, { host: target.alias })) }
      });
      operationId = snapshot.operationId;
      return snapshot;
    };
    const outer = coordinator.start(options(hosts.slice(0, 2), "sequential", start));
    await tick();
    manager.cancel(outer.operationId);

    await expect(terminal(manager, outer.operationId)).resolves.toMatchObject({
      state: "cancelled",
      result: { hosts: [{ host: "host-1", state: "cancelled" }, { host: "host-2", state: "cancelled" }] }
    });
    expect(started).toEqual(["host-1"]);
  });

  it("允许 10 台，拒绝 11 台且零子操作", () => {
    const manager = new OperationManager({ idFactory: sequence("outer") });
    const coordinator = new MultiHostCoordinator(manager);
    let starts = 0;
    const start = () => { starts += 1; throw new Error("不应启动"); };
    expect(() => coordinator.start(options(hosts, "parallel", start))).toThrow("1–10");
    expect(starts).toBe(0);
  });

  it("把每个子操作的新 stdout/stderr 恰好一次转发到父操作，并在子操作过期后保留 host 归属", async () => {
    const clock = new FakeClock();
    const manager = new OperationManager({
      clock,
      idFactory: sequence("outer", "one", "two"),
      limits: { resultRetentionMs: 1 }
    });
    const coordinator = new MultiHostCoordinator(manager);
    let second = "";
    const outer = coordinator.start(options(hosts.slice(0, 2), "sequential", (target) => {
      const snapshot = manager.create({ initialState: "running", runner: { cancel: () => undefined }, timeoutKind: "command" });
      if (target.alias === "host-1") {
        manager.appendOutput(snapshot.operationId, "stdout", Buffer.from("one-out"));
        manager.appendOutput(snapshot.operationId, "stderr", Buffer.from("one-err"));
        manager.complete(snapshot.operationId, { host: target.alias });
      } else {
        second = snapshot.operationId;
      }
      return snapshot;
    }));

    await eventually(() => second.length > 0);
    clock.advance(1);
    expect(() => manager.get("one")).toThrow("操作已过期");
    manager.appendOutput(second, "stderr", Buffer.from("two-err"));
    manager.complete(second, { host: "host-2" });

    const result = await terminal(manager, outer.operationId);
    expect(result.frames).toEqual([
      expect.objectContaining({ host: "host-1", stream: "stdout", data: "one-out" }),
      expect.objectContaining({ host: "host-1", stream: "stderr", data: "one-err" }),
      expect.objectContaining({ host: "host-2", stream: "stderr", data: "two-err" })
    ]);
    const next = manager.get(outer.operationId, result.nextCursor);
    expect(next.frames).toEqual([]);
  });

  it("child 同步预写超过 256KiB 后保持 running，父级无需后续事件也会完整且恰好一次排空", async () => {
    const manager = new OperationManager({ idFactory: sequence("outer", "one") });
    const coordinator = new MultiHostCoordinator(manager);
    const payload = Buffer.concat(Array.from({ length: 5 }, (_value, index) => Buffer.alloc(65_536, index + 1)));
    let childId = "";
    const outer = coordinator.start(options([hosts[0]!], "parallel", (target) => {
      const snapshot = manager.create({ initialState: "running", runner: { cancel: () => undefined }, timeoutKind: "command" });
      childId = snapshot.operationId;
      manager.appendOutput(snapshot.operationId, "stdout", payload);
      // 特意不再写输出、进度或终态，复现单轮 4 次读取后的无事件边界。
      void target;
      return snapshot;
    }));

    await eventually(() => childId.length > 0 && manager.get(outer.operationId).nextCursor === manager.get(childId).nextCursor);
    expect(manager.get(childId).state).toBe("running");
    expect(manager.get(outer.operationId).state).toBe("running");

    const frames = readAllFrames(manager, outer.operationId);
    expect(frames.every((frame) => frame.host === "host-1" && frame.stream === "stdout")).toBe(true);
    expect(Buffer.concat(frames.map((frame) => Buffer.from(frame.data, frame.encoding))).equals(payload)).toBe(true);
    expect(frames.reduce((total, frame) => total + Buffer.byteLength(frame.data, frame.encoding), 0)).toBe(payload.length);
  });

  it("顺序模式将每台取消确认窗口计入父预算，首台超时后仍启动下一台", async () => {
    const clock = new FakeClock();
    const manager = new OperationManager({
      clock,
      idFactory: sequence("outer", "one", "two"),
      limits: { commandTimeoutMs: 1, cancelConfirmationTimeoutMs: 10 }
    });
    const coordinator = new MultiHostCoordinator(manager);
    const started: string[] = [];
    let second = "";
    const outer = coordinator.start(options(hosts.slice(0, 2), "sequential", (target) => {
      started.push(target.alias);
      const snapshot = manager.create({ initialState: "running", runner: { cancel: () => undefined }, timeoutKind: "command" });
      if (target.alias === "host-2") second = snapshot.operationId;
      return snapshot;
    }));

    await eventually(() => started.length === 1);
    clock.advance(1);
    clock.advance(10);
    await eventually(() => started.length === 2);
    expect(manager.get(outer.operationId).state).toBe("running");
    manager.complete(second, { host: "host-2" });
    await expect(terminal(manager, outer.operationId)).resolves.toMatchObject({
      state: "unknown",
      result: { hosts: [{ state: "unknown" }, { state: "completed" }] }
    });
  });

  it("顺序两台均耗尽超时与停止确认窗口时，最坏 5ms 相位后仍完整启动并聚合", async () => {
    const clock = new FakeClock();
    const manager = new OperationManager({
      clock,
      idFactory: sequence("outer", "one", "two"),
      limits: { commandTimeoutMs: 1, cancelConfirmationTimeoutMs: 10 }
    });
    const coordinator = new MultiHostCoordinator(manager);
    const started: string[] = [];
    const outer = coordinator.start(options(hosts.slice(0, 2), "sequential", (target) => {
      started.push(target.alias);
      return manager.create({ initialState: "running", runner: { cancel: () => undefined }, timeoutKind: "command" });
    }));

    await eventually(() => started.length === 1);
    clock.advance(1);
    // 把首台的 T+C=11ms 终态观察延后到 16ms，模拟旧 5ms 轮询的最坏相位。
    clock.advance(15);
    await eventually(() => started.length === 2);
    expect(manager.get(outer.operationId).state).toBe("running");

    clock.advance(1);
    clock.advance(15);
    await expect(terminal(manager, outer.operationId)).resolves.toMatchObject({
      state: "unknown",
      result: {
        stopRequested: false,
        hosts: [{ host: "host-1", state: "unknown" }, { host: "host-2", state: "unknown" }]
      }
    });
    expect(started).toEqual(["host-1", "host-2"]);
  });

  it("并行模式最后一台在同步慢启动后仍拥有完整超时与停止确认窗口", async () => {
    const clock = new FakeClock();
    const manager = new OperationManager({
      clock,
      idFactory: sequence("outer", "one", "two"),
      limits: { commandTimeoutMs: 1, cancelConfirmationTimeoutMs: 10 }
    });
    const coordinator = new MultiHostCoordinator(manager);
    const started: string[] = [];
    const outer = coordinator.start(options(hosts.slice(0, 2), "parallel", (target) => {
      started.push(target.alias);
      const snapshot = manager.create({ initialState: "running", runner: { cancel: () => undefined }, timeoutKind: "command" });
      if (target.alias === "host-1") clock.advance(5);
      return snapshot;
    }));

    await eventually(() => started.length === 2);
    expect(manager.get(outer.operationId).state).toBe("running");
    clock.advance(1);
    clock.advance(10);
    await expect(terminal(manager, outer.operationId)).resolves.toMatchObject({
      state: "unknown",
      result: {
        stopRequested: false,
        hosts: [{ host: "host-1", state: "unknown" }, { host: "host-2", state: "unknown" }]
      }
    });
    expect(started).toEqual(["host-1", "host-2"]);
  });
});

function harness(outcomes: Readonly<Record<string, "completed" | "failed">>) {
  const ids = ["outer", ...Object.keys(outcomes).map((alias) => `child-${alias}`)];
  const manager = new OperationManager({ idFactory: sequence(...ids) });
  const coordinator = new MultiHostCoordinator(manager);
  const start = (target: HostConfig): OperationSnapshot => {
    const snapshot = manager.create({ initialState: "running", runner: { cancel: () => undefined }, timeoutKind: "command" });
    queueMicrotask(() => {
      if (outcomes[target.alias] === "completed") manager.complete(snapshot.operationId, { host: target.alias });
      else manager.fail(snapshot.operationId);
    });
    return snapshot;
  };
  return { manager, coordinator, start };
}

async function terminal(manager: OperationManager, operationId: string) {
  for (let index = 0; index < 100; index += 1) {
    const snapshot = manager.get(operationId);
    if (!["awaiting_approval", "running"].includes(snapshot.state)) return snapshot;
    await tick();
  }
  throw new Error("操作未在预期时间内结束");
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 30; index += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error("条件未在预期时间内满足");
}

function readAllFrames(manager: OperationManager, operationId: string) {
  const frames = [] as ReturnType<OperationManager["get"]>["frames"][number][];
  let cursor = 0;
  while (true) {
    const read = manager.get(operationId, cursor, 262_144);
    frames.push(...read.frames);
    if (read.nextCursor === cursor) return frames;
    cursor = read.nextCursor;
  }
}

function sequence(...ids: string[]): () => string {
  return () => ids.shift() ?? `extra-${Math.random()}`;
}

function host(alias: string): HostConfig {
  return {
    alias, environment: "test", platform: "linux", host: "127.0.0.1", port: 22, username: "tester",
    auth: { type: "pageant" }, shell: { type: "posix", command: "/bin/sh" }, remoteRoots: ["/remote"]
  };
}

function options(hosts: readonly HostConfig[], executionMode: "parallel" | "sequential", start: (host: HostConfig) => OperationSnapshot) {
  return { hosts, executionMode, timeoutKind: "command" as const, failureCode: "COMMAND_FAILED" as const, timeoutCode: "COMMAND_TIMEOUT" as const, start };
}

class FakeClock implements MonotonicClock {
  private nowMs = 0;
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
