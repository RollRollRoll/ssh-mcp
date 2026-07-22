import { describe, expect, it } from "vitest";
import { ApprovalCoordinator, type ApprovalClock } from "../../src/approval/approval-coordinator.js";
import { createOperationIntent } from "../../src/approval/operation-intent.js";
import type { HostConfig } from "../../src/config/schema.js";
import { OperationControlService } from "../../src/console/operation-control-service.js";
import { RuntimeRevisionHub } from "../../src/console/runtime-revision-hub.js";
import { RuntimeSnapshotProjector } from "../../src/console/runtime-snapshot-projector.js";
import { HostRegistry } from "../../src/hosts/host-registry.js";
import { OperationManager, type MonotonicClock, type OperationRunner } from "../../src/operations/operation-manager.js";
import { SessionManager } from "../../src/sessions/session-manager.js";

class Clock implements MonotonicClock, ApprovalClock {
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
  public advance(ms: number): void {
    this.nowMs += ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.due <= this.nowMs);
      if (due.length === 0) return;
      for (const [id, timer] of due) { this.timers.delete(id); timer.callback(); }
    }
  }
}

describe("RuntimeRevisionHub", () => {
  it("合并同一调度周期的失效、单调递增并释放订阅", () => {
    const scheduled: Array<() => void> = [];
    const hub = new RuntimeRevisionHub({ schedule: (callback) => scheduled.push(callback), maxSubscribers: 2 });
    const events: unknown[] = [];
    const unsubscribe = hub.subscribe((event) => events.push(event));
    hub.subscribe(() => { throw new Error("订阅者异常"); });
    hub.invalidate("operations");
    hub.invalidate("hosts");
    hub.invalidate("operations");
    expect(scheduled).toHaveLength(1);
    expect(hub.revision).toBe(0);

    scheduled.shift()!();
    expect(events).toEqual([{ revision: 1, scopes: ["hosts", "operations"] }]);
    hub.invalidate("sessions");
    scheduled.shift()!();
    expect(events).toHaveLength(2);
    expect(hub.revision).toBe(2);

    unsubscribe();
    hub.close();
    hub.invalidate("approvals");
    expect(events).toHaveLength(2);
    expect(() => hub.subscribe(() => undefined)).toThrow("已关闭");
  });
});

describe("RuntimeSnapshotProjector", () => {
  it("从本实例事实源生成稳定安全快照，不展开配置、路径、结果、错误或演示状态", () => {
    const scheduled: Array<() => void> = [];
    const hub = new RuntimeRevisionHub({ schedule: (callback) => scheduled.push(callback) });
    const clock = new Clock();
    const hosts = new HostRegistry([host("beta"), host("alpha")]);
    const operations = new OperationManager({ clock, idFactory: () => "transfer-1", outputBufferBytes: 2 });
    const sessions = new SessionManager({ idFactory: () => "session-1" });
    const approvals = new ApprovalCoordinator({
      client: { supportsFormElicitation: () => false, elicit: async () => ({ action: "cancel" }) },
      clock,
      idFactory: () => "approval-1"
    });
    hosts.subscribe(() => hub.invalidate("hosts"));
    operations.subscribe(() => hub.invalidate("operations"));
    sessions.subscribe(() => hub.invalidate("sessions"));
    approvals.subscribe(() => hub.invalidate("approvals"));
    const projector = new RuntimeSnapshotProjector({
      instanceId: "instance-one", revisions: hub, hosts, operations, sessions, approvals
    });

    expect(projector.snapshot()).toMatchObject({
      revision: 0, serviceState: "active", operations: [], sessions: [], approvals: [], profiles: []
    });
    hosts.connectionOpened("alpha");
    operations.create({
      initialState: "running", source: "mcp", operationKind: "transfer", target: { hosts: ["alpha"] }
    });
    operations.updateResult("transfer-1", {
      transferredBytes: 4, totalBytes: 9, source: "/local/private", target: "/remote/private",
      error: new Error("内部错误")
    });
    operations.appendOutput("transfer-1", "stdout", Buffer.from("abc"));
    sessions.reserve({ host: "alpha", platform: "linux", shell: "posix", columns: 80, rows: 24 });
    const intent = createOperationIntent({
      kind: "raw_command", hosts: ["alpha"], platformByHost: { alpha: "linux" },
      payload: { command: "echo 完整审批命令" }
    });
    approvals.request(intent, () => undefined, { route: "web_only", operationId: "transfer-1" });
    expect(scheduled).toHaveLength(1);
    scheduled.shift()!();

    const snapshot = projector.snapshot();
    expect(snapshot.revision).toBe(1);
    expect(snapshot.hosts.map((entry) => entry.alias)).toEqual(["alpha", "beta"]);
    expect(snapshot.operations[0]).toMatchObject({
      operationId: "transfer-1", kind: "transfer", hosts: ["alpha"], outputTruncated: true,
      progress: { transferredBytes: 4, totalBytes: 9 }
    });
    expect(snapshot.sessions[0]).toMatchObject({ sessionId: "session-1", host: "alpha", state: "opening" });
    expect(snapshot.approvals[0]).toMatchObject({
      approvalId: "approval-1", operationId: "transfer-1", state: "pending", hosts: ["alpha"],
      safeView: { operation: { payload: { command: "echo 完整审批命令" } } }
    });
    const serialized = JSON.stringify(snapshot);
    for (const forbidden of ["private-key", "/allowed", "/local/private", "/remote/private", "内部错误", "username"]) {
      expect(serialized).not.toContain(forbidden);
    }

    projector.setQuiescing();
    scheduled.shift()!();
    expect(projector.snapshot()).toMatchObject({ revision: 2, serviceState: "quiescing" });
    approvals.shutdown();
  });
});

describe("OperationControlService", () => {
  it("待审批取消由协调器结算，且不会执行副作用", async () => {
    const clock = new Clock();
    const operations = new OperationManager({ clock, idFactory: () => "pending-operation" });
    operations.create({
      initialState: "awaiting_approval", approvalTimeoutManagedExternally: true,
      target: { hosts: ["alpha"] }
    });
    const approvals = new ApprovalCoordinator({
      client: { supportsFormElicitation: () => false, elicit: async () => ({ action: "accept" }) },
      clock,
      idFactory: () => "pending-approval"
    });
    let sideEffects = 0;
    const request = approvals.request(commandIntent(), () => { sideEffects += 1; }, {
      route: "web_only", operationId: "pending-operation"
    });
    const control = new OperationControlService(approvals, operations);

    expect(control.cancel("pending-operation")).toMatchObject({
      status: "approval_cancelled", operation: { state: "awaiting_approval" }
    });
    await expect(request.result).resolves.toMatchObject({ approved: false, error: { code: "APPROVAL_DECLINED" } });
    expect(approvals.get("pending-approval")).toMatchObject({ state: "cancelled", resolvedBy: "web" });
    expect(sideEffects).toBe(0);
    approvals.shutdown();
  });

  it("运行中重复取消只请求一次，确认后才显示 cancelled", () => {
    const clock = new Clock();
    const runner: OperationRunner & { calls: number } = { calls: 0, cancel() { this.calls += 1; } };
    const operations = new OperationManager({ clock, idFactory: () => "running-operation" });
    operations.create({ initialState: "running", runner, target: { hosts: ["alpha"] } });
    const approvals = coordinator(clock);
    const control = new OperationControlService(approvals, operations);

    expect(control.cancel("running-operation")).toMatchObject({
      status: "cancel_requested", operation: { state: "running", cancelRequested: true }
    });
    expect(control.cancel("running-operation")).toMatchObject({ status: "cancel_requested" });
    expect(runner.calls).toBe(1);
    operations.confirmStopped("running-operation");
    expect(control.cancel("running-operation")).toMatchObject({
      status: "terminal", operation: { state: "cancelled", cancelRequested: false }
    });
    approvals.shutdown();
  });

  it("取消与完成竞争保留 completed，停止无法确认则保留 unknown", () => {
    const clock = new Clock();
    let racing!: OperationManager;
    racing = new OperationManager({ clock, idFactory: () => "race" });
    racing.create({ initialState: "running", runner: { cancel: () => { racing.complete("race"); } } });
    const approvals = coordinator(clock);
    expect(new OperationControlService(approvals, racing).cancel("race")).toMatchObject({
      status: "terminal", operation: { state: "completed" }
    });

    const hanging = new OperationManager({
      clock,
      idFactory: () => "hanging",
      limits: { cancelConfirmationTimeoutMs: 5 }
    });
    hanging.create({ initialState: "running", runner: { cancel: () => undefined } });
    const control = new OperationControlService(approvals, hanging);
    control.cancel("hanging");
    clock.advance(5);
    expect(control.cancel("hanging")).toMatchObject({
      status: "terminal", operation: { state: "unknown", cancelRequested: false }
    });
    approvals.shutdown();
  });
});

function host(alias: string): HostConfig {
  return {
    alias,
    environment: "development",
    platform: "linux",
    host: `${alias}.internal`,
    port: 22,
    username: "secret-user",
    auth: { type: "privateKeyFile", path: "/private-key" },
    shell: { type: "posix", command: "/bin/sh" },
    remoteRoots: ["/allowed"]
  };
}

function commandIntent() {
  return createOperationIntent({
    kind: "raw_command", hosts: ["alpha"], platformByHost: { alpha: "linux" }, payload: { command: "true" }
  });
}

function coordinator(clock: Clock): ApprovalCoordinator {
  return new ApprovalCoordinator({
    client: { supportsFormElicitation: () => false, elicit: async () => ({ action: "cancel" }) },
    clock
  });
}
