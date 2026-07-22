import { describe, expect, it } from "vitest";
import { testWithIds } from "../test-with-ids.js";
import {
  OperationManager,
  type MonotonicClock,
  type OperationRunner
} from "../../src/operations/operation-manager.js";
import { OutputBuffer } from "../../src/operations/output-buffer.js";
import { OperationStateMachine } from "../../src/operations/state-machine.js";
import * as stateMachine from "../../src/operations/state-machine.js";

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
  public pendingTimerCount(): number { return this.timers.size; }
  public advance(delayMs: number): void {
    this.nowMs += delayMs;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.due <= this.nowMs);
      if (due.length === 0) return;
      for (const [id, timer] of due) { this.timers.delete(id); timer.callback(); }
    }
  }
}

describe("OutputBuffer", () => {
  it("按原始字节淘汰、保留 stdout/stderr 顺序，并无损表示二进制片段", () => {
    const output = new OutputBuffer(5);
    output.append("stdout", Buffer.from("abc"));
    output.append("stderr", Buffer.from([0xff, 0x00, 0x61]));

    expect(output.read(0, 5)).toEqual({
      frames: [
        { stream: "stdout", cursor: 1, encoding: "utf8", data: "bc" },
        { stream: "stderr", cursor: 3, encoding: "base64", data: "/wBh" }
      ],
      nextCursor: 6,
      minCursor: 1,
      truncated: true,
      droppedBytes: 1
    });
  });

  it("允许从 frame 中间按字节读取，拒绝未来或非安全游标", () => {
    const output = new OutputBuffer();
    output.append("stdout", Buffer.from("hello"));

    expect(output.read(2, 2)).toMatchObject({
      frames: [{ stream: "stdout", cursor: 2, encoding: "utf8", data: "ll" }],
      nextCursor: 4,
      truncated: false
    });
    expectError(() => output.read(6, 1), "INVALID_CURSOR");
    expectError(() => output.read(Number.MAX_SAFE_INTEGER + 1, 1), "INVALID_CURSOR");
  });

  it("旧游标只报告本次请求实际缺失的字节数，包括 frame 部分淘汰", () => {
    const output = new OutputBuffer(4);
    output.append("stdout", Buffer.from("abc"));
    output.append("stderr", Buffer.from("def"));

    expect(output.read(1, 4)).toMatchObject({
      minCursor: 2,
      truncated: true,
      droppedBytes: 1,
      frames: [
        { stream: "stdout", cursor: 2, data: "c" },
        { stream: "stderr", cursor: 3, data: "def" }
      ]
    });
    expect(output.read(2, 4)).toMatchObject({ truncated: false, droppedBytes: 0 });
  });

  it("大量小 frame 的连续增量读取不反复从历史首帧扫描", () => {
    const output = new OutputBuffer(20_000);
    for (let index = 0; index < 2_000; index += 1) output.append("stdout", Buffer.from("x"));

    let cursor = 0;
    for (let index = 0; index < 2_000; index += 1) {
      const read = output.readEntries(cursor, 1);
      cursor = read.nextCursor;
    }

    expect(cursor).toBe(2_000);
    // 二分定位加实际读取约为 n·log₂n，远小于旧实现的 1+…+n 历史帧扫描。
    expect(output.entryFrameInspectionCount()).toBeLessThan(30_000);
  });

  it("超过容量的大量 1-byte frame 仍保持固定 frame 上界与摊销访问", () => {
    const output = new OutputBuffer(20_000);
    for (let index = 0; index < 100_000; index += 1) {
      output.append(index % 2 === 0 ? "stdout" : "stderr", Buffer.from("x"));
    }

    const read = output.readEntries(0, 20_000);
    expect(read.truncated).toBe(true);
    expect(read.droppedBytes).toBe(read.minCursor);
    expect(read.frames.length).toBeLessThanOrEqual(4_096);
    expect(read.nextCursor).toBe(100_000);
    expect(output.entryFrameInspectionCount()).toBeLessThan(4_200);
  });

  it("32 MiB 单帧与反复超大单帧只保留容量内尾部，不持有已淘汰 backing store", () => {
    const capacity = 4;
    const output = new OutputBuffer(capacity);
    const oversized = Buffer.alloc(32 * 1024 * 1024, 0x61);

    for (let index = 0; index < 5; index += 1) {
      oversized[oversized.length - 1] = 0x61 + index;
      output.append(index % 2 === 0 ? "stdout" : "stderr", oversized);
      const stores = storedBackingStores(output);
      expect([...stores].reduce((sum, store) => sum + store.byteLength, 0)).toBeLessThanOrEqual(capacity);
    }

    const read = output.readEntries(0, capacity);
    expect(read).toMatchObject({
      minCursor: oversized.length * 5 - capacity,
      nextCursor: oversized.length * 5,
      droppedBytes: oversized.length * 5 - capacity,
      truncated: true
    });
    expect(read.frames).toHaveLength(1);
    expect(read.frames[0]).toMatchObject({ stream: "stdout", cursor: oversized.length * 5 - capacity });
  });
});

describe("OperationManager", () => {
  it("控制台列表稳定排序并只投影来源、类型、别名、截断和白名单进度", () => {
    const clock = new FakeClock();
    const ids = ["z-operation", "a-operation"];
    const manager = new OperationManager({
      clock,
      idFactory: () => ids.shift()!,
      outputBufferBytes: 2
    });
    manager.create({
      initialState: "running",
      source: "web",
      operationKind: "transfer",
      target: { hosts: ["alpha"] }
    });
    manager.updateResult("z-operation", {
      transferredBytes: 3,
      totalBytes: 8,
      source: "/secret/local",
      target: "/secret/remote",
      arbitrary: { password: "不得投影" }
    });
    manager.appendOutput("z-operation", "stdout", Buffer.from("123"));
    manager.create({ initialState: "running", target: { hosts: ["beta"] } });

    const list = manager.listForConsole();
    expect(list.map((operation) => operation.operationId)).toEqual(["a-operation", "z-operation"]);
    expect(list[1]).toEqual({
      operationId: "z-operation",
      source: "web",
      kind: "transfer",
      hosts: ["alpha"],
      state: "running",
      cancelRequested: false,
      lastStateChangeAt: 0,
      outputTruncated: true,
      progress: { transferredBytes: 3, totalBytes: 8 }
    });
    expect(JSON.stringify(list)).not.toContain("secret");
    expect(Object.isFrozen(list)).toBe(true);
    expect(Object.isFrozen(list[1].progress)).toBe(true);
    expect(manager.get("z-operation")).not.toHaveProperty("source");
    expect(manager.get("z-operation")).not.toHaveProperty("kind");
    expect(manager.get("z-operation")).not.toHaveProperty("cancelRequested");
  });

  it("全局变化钩子可释放，取消请求立即可见且停止证据决定最终状态", () => {
    const runner = new FakeRunner();
    const manager = new OperationManager({ idFactory: () => "observed" });
    let changes = 0;
    const unsubscribe = manager.subscribe(() => { changes += 1; });
    manager.subscribe(() => { throw new Error("观察者异常"); });
    manager.create({ initialState: "running", runner });
    expect(changes).toBe(1);

    manager.cancel("observed");
    expect(changes).toBe(2);
    expect(manager.describeForConsole("observed")).toMatchObject({ state: "running", cancelRequested: true });
    expect(runner.cancelCalls).toBe(1);

    manager.cancel("observed");
    expect(runner.cancelCalls).toBe(1);
    manager.confirmStopped("observed");
    expect(manager.describeForConsole("observed")).toMatchObject({ state: "cancelled", cancelRequested: false });
    unsubscribe();
    manager.appendOutput("observed", "stdout", Buffer.from("late"));
    expect(changes).toBe(3);
  });

  it("快照保存不可变主机目标摘要，并只在状态转换时单调更新时间", () => {
    const clock = new FakeClock();
    const hosts = ["alpha"];
    const manager = new OperationManager({ clock, idFactory: () => "target" });
    manager.create({ initialState: "awaiting_approval", target: { hosts } });
    hosts[0] = "tampered";

    const awaiting = manager.get("target");
    expect(awaiting).toMatchObject({
      host: "alpha", target: { hosts: ["alpha"] }, lastStateChangeAt: 0
    });
    expect(Object.isFrozen(awaiting.target)).toBe(true);
    clock.advance(7);
    manager.updateResult("target", { progress: 1 });
    expect(manager.get("target").lastStateChangeAt).toBe(0);
    manager.start("target");
    expect(manager.get("target")).toMatchObject({ state: "running", lastStateChangeAt: 7 });
  });

  it("真实输出淘汰只发布白名单所需的截断统计", () => {
    const events: unknown[] = [];
    const manager = new OperationManager({
      idFactory: () => "truncated",
      outputBufferBytes: 4,
      onOutputTruncated: (event) => events.push(event)
    });
    manager.create({ initialState: "running", target: { hosts: ["alpha"] } });
    manager.appendOutput("truncated", "stdout", Buffer.from("123456"));

    expect(events).toEqual([{
      operationId: "truncated", host: "alpha", droppedBytes: 2, minCursor: 2
    }]);
  });

  it("大量小块淘汰按 operation 使用固定事件预算，最终摘要完整且互不串扰", () => {
    const ids = ["truncated-one", "truncated-two"];
    const events: Array<{ operationId: string; droppedBytes: number; minCursor: number }> = [];
    const manager = new OperationManager({
      idFactory: () => ids.shift()!,
      outputBufferBytes: 1,
      onOutputTruncated: (event) => events.push(event)
    });
    manager.create({ initialState: "running" });
    manager.create({ initialState: "running" });

    for (let index = 0; index < 10_000; index += 1) {
      manager.appendOutput("truncated-one", "stdout", Buffer.from("x"));
      manager.appendOutput("truncated-two", "stderr", Buffer.from("y"));
    }
    manager.complete("truncated-one");
    manager.complete("truncated-two");

    for (const operationId of ["truncated-one", "truncated-two"]) {
      const own = events.filter((event) => event.operationId === operationId);
      expect(own.length).toBeLessThanOrEqual(4);
      expect(own.at(-1)?.minCursor).toBe(9_999);
      expect(own.reduce((sum, event) => sum + event.droppedBytes, 0)).toBe(9_999);
    }
  });

  it("shutdown 幂等且有界，挂起运行器截止后只能收敛为 unknown 并拒绝新操作", async () => {
    const clock = new FakeClock();
    const runner = new FakeRunner();
    const manager = new OperationManager({ clock, idFactory: () => "shutdown-operation" });
    manager.create({ initialState: "running", runner });
    const first = manager.shutdown(5);
    const second = manager.shutdown(5);
    expect(first).toBe(second);
    expect(runner.cancelCalls).toBe(1);
    expect(manager.get("shutdown-operation").state).toBe("running");
    clock.advance(5);
    await expect(first).resolves.toBeUndefined();
    expect(manager.get("shutdown-operation")).toMatchObject({
      state: "unknown", error: { code: "CANCEL_UNCONFIRMED", sideEffects: "possible" }
    });
    expectError(() => manager.create({ initialState: "running" }), "RESOURCE_LIMIT");
  });

  it("只允许状态机主路径，操作终态提交幂等", () => {
    const manager = new OperationManager({ idFactory: () => "state" });
    manager.create({ initialState: "awaiting_approval" });
    expect(manager.start("state").state).toBe("running");
    expect(manager.complete("state").state).toBe("completed");
    expect(manager.fail("state").state).toBe("completed");
  });

  testWithIds(["LC-SC-018", "LC-SC-037"],
    "取消运行项只请求一次；确认停止前保持 running，10 秒后变 unknown", async () => {
    const clock = new FakeClock();
    const runner = new FakeRunner();
    const manager = new OperationManager({ clock, idFactory: () => "running" });
    manager.create({ initialState: "running", runner });

    expect(manager.cancel("running").state).toBe("running");
    expect(manager.cancel("running").state).toBe("running");
    expect(runner.cancelCalls).toBe(1);
    clock.advance(10_000);

    expect(manager.get("running")).toMatchObject({
      state: "unknown",
      error: { code: "CANCEL_UNCONFIRMED", finalState: "unknown", retriable: false }
    });
  });

  testWithIds(["LC-SC-035"], "运行器明确确认停止后才进入 cancelled；尚未启动不调用运行器", () => {
    const runner = new FakeRunner();
    const ids = ["one", "two"];
    const manager = new OperationManager({ idFactory: () => ids.shift() ?? "extra" });
    manager.create({ initialState: "running", runner });
    manager.cancel("one");
    expect(manager.confirmStopped("one").state).toBe("cancelled");

    manager.create({ initialState: "running" });
    expect(manager.cancel("two").state).toBe("cancelled");
    expect(runner.cancelCalls).toBe(1);
  });

  testWithIds(["SC-034"], "超时也需停止确认；超时取消未确认时为不可重试 unknown", () => {
    const clock = new FakeClock();
    const runner = new FakeRunner();
    const manager = new OperationManager({ clock, idFactory: () => "timeout" });
    manager.create({ initialState: "running", runner, timeoutMs: 20 });
    clock.advance(20);
    expect(runner.cancelCalls).toBe(1);
    expect(manager.confirmStopped("timeout").state).toBe("timed_out");
  });

  it("真实 awaiting_approval 操作在 120 秒后失败并开始保留期", () => {
    const clock = new FakeClock();
    const manager = new OperationManager({ clock, idFactory: () => "approval" });
    manager.create();

    clock.advance(119_999);
    expect(manager.get("approval").state).toBe("awaiting_approval");
    clock.advance(1);
    expect(manager.get("approval")).toMatchObject({
      state: "failed",
      error: {
        code: "APPROVAL_TIMEOUT",
        finalState: "failed",
        retriable: false,
        sideEffects: "none"
      }
    });
    clock.advance(900_000);
    expectError(() => manager.get("approval"), "OPERATION_EXPIRED");
  });

  it("启动操作会清除审批计时器", () => {
    const clock = new FakeClock();
    const manager = new OperationManager({ clock, idFactory: () => "started" });
    manager.create();
    clock.advance(119_999);
    manager.start("started");
    clock.advance(120_000);

    expect(manager.get("started").state).toBe("running");
  });

  it("终态首个提交获胜，晚到或重复的停止确认只返回现有快照", () => {
    const clock = new FakeClock();
    const runner = new FakeRunner();
    const ids = ["cancelled", "completed", "unknown"];
    const manager = new OperationManager({ clock, idFactory: () => ids.shift() ?? "extra" });

    manager.create({ initialState: "running", runner });
    manager.cancel("cancelled");
    expect(manager.confirmStopped("cancelled").state).toBe("cancelled");
    expect(manager.confirmStopped("cancelled").state).toBe("cancelled");

    manager.create({ initialState: "running", runner });
    manager.cancel("completed");
    expect(manager.complete("completed").state).toBe("completed");
    expect(manager.confirmStopped("completed").state).toBe("completed");

    manager.create({ initialState: "running", runner });
    manager.cancel("unknown");
    clock.advance(10_000);
    expect(manager.confirmStopped("unknown").state).toBe("unknown");
  });

  it("取消确认与确认窗口同刻时首个终态获胜", () => {
    const clock = new FakeClock();
    const manager = new OperationManager({ clock, idFactory: () => "same-tick" });
    manager.create({ initialState: "running", runner: new FakeRunner() });
    manager.cancel("same-tick");
    clock.setTimeout(() => manager.confirmStopped("same-tick"), 10_000);

    clock.advance(10_000);
    expect(manager.get("same-tick").state).toBe("unknown");
  });

  it("终态和 awaiting_approval 状态忽略晚到输出", () => {
    const ids = ["awaiting", "completed", "cancelled", "unknown"];
    const clock = new FakeClock();
    const manager = new OperationManager({ clock, idFactory: () => ids.shift() ?? "extra" });
    manager.create();
    manager.appendOutput("awaiting", "stdout", Buffer.from("late"));
    expect(manager.get("awaiting").nextCursor).toBe(0);

    manager.create({ initialState: "running" });
    manager.complete("completed");
    manager.appendOutput("completed", "stdout", Buffer.from("late"));
    expect(manager.get("completed").nextCursor).toBe(0);

    manager.create({ initialState: "running" });
    manager.cancel("cancelled");
    manager.appendOutput("cancelled", "stdout", Buffer.from("late"));
    expect(manager.get("cancelled").nextCursor).toBe(0);

    manager.create({ initialState: "running", runner: new FakeRunner() });
    manager.cancel("unknown");
    clock.advance(10_000);
    manager.appendOutput("unknown", "stdout", Buffer.from("late"));
    expect(manager.get("unknown").nextCursor).toBe(0);
  });

  it("超时停止未确认时保留 timeout 原因", () => {
    const clock = new FakeClock();
    const manager = new OperationManager({ clock, idFactory: () => "timeout-unknown" });
    manager.create({ initialState: "running", runner: new FakeRunner(), timeoutKind: "transfer", timeoutMs: 1 });
    clock.advance(1);
    clock.advance(10_000);

    expect(manager.get("timeout-unknown")).toMatchObject({
      state: "unknown",
      error: {
        code: "STATE_UNKNOWN",
        finalState: "unknown",
        retriable: false,
        details: { reason: "timeout", timeoutKind: "transfer" }
      }
    });
  });

  it("运行项的非法有效预算不会发布记录", () => {
    const manager = new OperationManager({ idFactory: () => "invalid-create" });

    expect(() => manager.create({ initialState: "running", timeoutMs: 0 })).toThrow(RangeError);
    expectError(() => manager.get("invalid-create"), "OPERATION_NOT_FOUND");
  });

  it("父协调器专用无业务超时 API 不影响显式取消协议", () => {
    const clock = new FakeClock();
    const runner = new FakeRunner();
    const manager = new OperationManager({ clock, idFactory: () => "parent" });
    manager.createWithoutBusinessTimeout({ initialState: "running", runner });

    clock.advance(10_000_000);
    expect(runner.cancelCalls).toBe(0);
    manager.cancel("parent");
    expect(runner.cancelCalls).toBe(1);
  });

  it("审批项启动的非法有效预算保持审批状态并继续审批计时", () => {
    const clock = new FakeClock();
    const manager = new OperationManager({ clock, idFactory: () => "invalid-start" });
    manager.create();

    expect(() => manager.start("invalid-start", undefined, 0)).toThrow(RangeError);
    expect(manager.get("invalid-start").state).toBe("awaiting_approval");
    clock.advance(120_000);
    expect(manager.get("invalid-start")).toMatchObject({
      state: "failed",
      error: { code: "APPROVAL_TIMEOUT" }
    });
  });

  it.each([
    ["connect", 15_000],
    ["transfer", 1_800_000]
  ] as const)("审批后的 %s 操作沿用业务预算与超时类别", (timeoutKind, timeoutMs) => {
    const clock = new FakeClock();
    const runner = new FakeRunner();
    const manager = new OperationManager({ clock, idFactory: () => timeoutKind });
    manager.create({ timeoutKind });
    manager.start(timeoutKind, runner);

    clock.advance(timeoutMs - 1);
    expect(runner.cancelCalls).toBe(0);
    clock.advance(1);
    expect(runner.cancelCalls).toBe(1);
    clock.advance(10_000);
    expect(manager.get(timeoutKind)).toMatchObject({
      state: "unknown",
      error: { details: { reason: "timeout", timeoutKind } }
    });
  });

  it("运行器同步确认停止时不遗留取消确认计时器", () => {
    const clock = new FakeClock();
    const manager = new OperationManager({ clock, idFactory: () => "synchronous-confirm" });
    const runner: OperationRunner = {
      cancel: () => { manager.confirmStopped("synchronous-confirm"); }
    };
    manager.create({ initialState: "running", runner });

    expect(manager.cancel("synchronous-confirm").state).toBe("cancelled");
    expect(clock.pendingTimerCount()).toBe(1);
  });

  it("不导出可变终态集合", () => {
    expect("terminalOperationStates" in stateMachine).toBe(false);
  });

  it("非终态的非法转换仍抛出错误", () => {
    expect(() => new OperationStateMachine("awaiting_approval").transition("completed")).toThrow(
      "非法操作状态转换"
    );
  });

  it.each([
    ["connect", 15_000],
    ["command", 300_000],
    ["session", 1_800_000],
    ["transfer", 1_800_000],
    ["approval", 120_000]
  ] as const)("%s 预算由可注入单调时钟触发停止请求", (timeoutKind, timeoutMs) => {
    const clock = new FakeClock();
    const runner = new FakeRunner();
    const manager = new OperationManager({ clock, idFactory: () => timeoutKind });
    manager.create({ initialState: "running", runner, timeoutKind });

    clock.advance(timeoutMs - 1);
    expect(runner.cancelCalls).toBe(0);
    clock.advance(1);
    expect(runner.cancelCalls).toBe(1);
  });

  it("活动操作最多 32 个，终态保留 15 分钟后稳定报告过期", () => {
    const clock = new FakeClock();
    let sequence = 0;
    const manager = new OperationManager({ clock, idFactory: () => `op-${++sequence}` });
    for (let index = 0; index < 32; index += 1) manager.create({ initialState: "running" });
    expectError(() => manager.create({ initialState: "running" }), "RESOURCE_LIMIT");
    manager.complete("op-1");
    expect(manager.create({ initialState: "running" }).operationId).toBe("op-33");
    clock.advance(900_000);
    expectError(() => manager.get("op-1"), "OPERATION_EXPIRED");
    expectError(() => manager.get("missing"), "OPERATION_NOT_FOUND");
  });

  it("终态记录和过期墓碑均固定有界，预算内不提前破坏 15 分钟保留", () => {
    const clock = new FakeClock();
    let sequence = 0;
    const manager = new OperationManager({ clock, idFactory: () => `bounded-${++sequence}` });

    for (let index = 0; index < 64; index += 1) {
      const operation = manager.create({ initialState: "running" });
      manager.complete(operation.operationId);
    }
    expect(manager.get("bounded-1").state).toBe("completed");
    expectError(() => manager.create({ initialState: "running" }), "RESOURCE_LIMIT");

    clock.advance(900_000);
    expectError(() => manager.get("bounded-1"), "OPERATION_EXPIRED");

    for (let index = 0; index < 64; index += 1) {
      const operation = manager.create({ initialState: "running" });
      manager.complete(operation.operationId);
    }
    clock.advance(900_000);

    expectError(() => manager.get("bounded-1"), "OPERATION_NOT_FOUND");
    expectError(() => manager.get("bounded-65"), "OPERATION_EXPIRED");
  });
});

function storedBackingStores(output: OutputBuffer): ReadonlySet<ArrayBufferLike> {
  const storage = output as unknown as {
    readonly frames: ReadonlyArray<{ readonly data: Buffer }>;
    readonly head: number;
  };
  return new Set(storage.frames.slice(storage.head).map((frame) => frame.data.buffer));
}

class FakeRunner implements OperationRunner {
  public cancelCalls = 0;
  public cancel(): void { this.cancelCalls += 1; }
}

function expectError(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("预期操作抛出错误");
  } catch (error: unknown) {
    expect(error).toMatchObject({ code });
  }
}
