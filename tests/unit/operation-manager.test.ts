import { describe, expect, it } from "vitest";
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
});

describe("OperationManager", () => {
  it("只允许状态机主路径，操作终态提交幂等", () => {
    const manager = new OperationManager({ idFactory: () => "state" });
    manager.create({ initialState: "awaiting_approval" });
    expect(manager.start("state").state).toBe("running");
    expect(manager.complete("state").state).toBe("completed");
    expect(manager.fail("state").state).toBe("completed");
  });

  it("取消运行项只请求一次；确认停止前保持 running，10 秒后变 unknown", async () => {
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

  it("运行器明确确认停止后才进入 cancelled；尚未启动不调用运行器", () => {
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

  it("超时也需停止确认；超时取消未确认时为不可重试 unknown", () => {
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
});

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
