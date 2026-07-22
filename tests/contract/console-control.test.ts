import { describe, expect, it } from "vitest";
import { ApprovalCoordinator, type ApprovalClock } from "../../src/approval/approval-coordinator.js";
import { createOperationIntent } from "../../src/approval/operation-intent.js";
import { ConsoleActionRoutes } from "../../src/console/action-routes.js";
import { OperationControlService } from "../../src/console/operation-control-service.js";
import { RuntimeRevisionHub } from "../../src/console/runtime-revision-hub.js";
import { RuntimeSnapshotProjector } from "../../src/console/runtime-snapshot-projector.js";
import type { HostConfig } from "../../src/config/schema.js";
import { HostRegistry } from "../../src/hosts/host-registry.js";
import { OperationManager, type MonotonicClock, type OperationRunner } from "../../src/operations/operation-manager.js";
import { SessionManager } from "../../src/sessions/session-manager.js";
import { testWithIds } from "../test-with-ids.js";

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
}

describe("控制台审批与取消", () => {
  testWithIds(["LC-SC-026"], "dual 审批向网页投影与 MCP 相同的完整安全意图", () => {
    const fixture = createFixture();
    const intent = commandIntent("printf '<script>中文</script>'");
    fixture.approvals.request(intent, () => undefined, { route: "dual", operationId: "operation-1" });
    fixture.flush();
    const approval = fixture.projector.snapshot().approvals[0]!;
    expect(approval).toMatchObject({
      route: "dual", state: "pending", digest: intent.digest,
      safeView: {
        operation: {
          kind: "raw_command", hosts: ["linux"], platformByHost: { linux: "linux" },
          payload: { command: "printf '<script>中文</script>'" }
        },
        impact: expect.stringContaining("精确操作一次")
      }
    });
    expect(JSON.stringify(approval)).not.toContain("linux.internal");
    fixture.approvals.shutdown();
  });

  testWithIds(["LC-SC-029", "LC-SC-030", "LC-AC-005"],
    "网页、MCP 与多标签页并发决定只有一个赢家且副作用至多一次", async () => {
    for (const webAction of ["accept", "decline", "cancel"] as const) {
      const fixture = createFixture();
      let sideEffects = 0;
      const request = fixture.approvals.request(commandIntent(`echo ${webAction}`), () => { sideEffects += 1; }, {
        route: "dual", operationId: "operation-1"
      });
      const approval = fixture.approvals.get(request.approvalId)!;
      const decisions = await Promise.allSettled([
        Promise.resolve().then(() => fixture.routes.handle(`/api/v1/approvals/${request.approvalId}/decision`, {
          action: webAction, expectedDigest: approval.digest
        })),
        Promise.resolve().then(() => fixture.approvals.settle(request.approvalId, "accept", "mcp")),
        Promise.resolve().then(() => fixture.routes.handle(`/api/v1/approvals/${request.approvalId}/decision`, {
          action: "accept", expectedDigest: approval.digest
        }))
      ]);
      expect(decisions.filter((item) => item.status === "fulfilled")).toHaveLength(2);
      await request.result;
      expect(sideEffects).toBeLessThanOrEqual(1);
      expect(fixture.approvals.get(request.approvalId)?.state).not.toBe("pending");
      expect(() => fixture.routes.handle(`/api/v1/approvals/${request.approvalId}/decision`, {
        action: "accept", expectedDigest: approval.digest
      })).toThrow(expect.objectContaining({ status: 409, code: "APPROVAL_ALREADY_RESOLVED" }));
      fixture.approvals.shutdown();
    }
  });

  testWithIds(["LC-SC-033"], "拒绝错误摘要与未知审批，不改变待审批状态", () => {
    const fixture = createFixture();
    let sideEffects = 0;
    const request = fixture.approvals.request(commandIntent("true"), () => { sideEffects += 1; }, { route: "dual" });
    expect(() => fixture.routes.handle(`/api/v1/approvals/${request.approvalId}/decision`, {
      action: "accept", expectedDigest: "0".repeat(64)
    })).toThrow(expect.objectContaining({ status: 409, code: "APPROVAL_INTENT_MISMATCH" }));
    expect(() => fixture.routes.handle("/api/v1/approvals/missing/decision", {
      action: "accept", expectedDigest: "0".repeat(64)
    })).toThrow(expect.objectContaining({ status: 404, code: "APPROVAL_NOT_FOUND" }));
    expect(fixture.approvals.get(request.approvalId)?.state).toBe("pending");
    expect(sideEffects).toBe(0);
    fixture.approvals.shutdown();
  });

  testWithIds(["LC-SC-038", "LC-SC-039"],
    "运行操作取消立即标记请求，重复请求幂等且最终状态服从真实停止结果", () => {
    const fixture = createFixture();
    const runner: OperationRunner & { calls: number } = { calls: 0, cancel() { this.calls += 1; } };
    fixture.operations.create({ initialState: "running", runner, target: { hosts: ["linux"] } });
    expect(fixture.routes.handle("/api/v1/operations/operation-1/cancel", {})).toMatchObject({
      body: { status: "cancel_requested", operation: { cancelRequested: true, state: "running" } }
    });
    expect(fixture.routes.handle("/api/v1/operations/operation-1/cancel", {})).toMatchObject({
      body: { status: "cancel_requested" }
    });
    expect(runner.calls).toBe(1);
    fixture.operations.complete("operation-1");
    expect(fixture.routes.handle("/api/v1/operations/operation-1/cancel", {})).toMatchObject({
      body: { status: "terminal", operation: { state: "completed", cancelRequested: false } }
    });
    expect(() => fixture.routes.handle("/api/v1/operations/missing/cancel", {}))
      .toThrow(expect.objectContaining({ status: 404, code: "OPERATION_NOT_FOUND" }));
    fixture.approvals.shutdown();
  });

  it("待审批操作取消不执行，且不会影响其他操作", async () => {
    const fixture = createFixture();
    fixture.operations.create({
      initialState: "awaiting_approval", approvalTimeoutManagedExternally: true, target: { hosts: ["linux"] }
    });
    fixture.operations.create({ initialState: "running", target: { hosts: ["linux"] } });
    let sideEffects = 0;
    const request = fixture.approvals.request(commandIntent("never"), () => { sideEffects += 1; }, {
      route: "dual", operationId: "operation-1"
    });
    expect(fixture.routes.handle("/api/v1/operations/operation-1/cancel", {})).toMatchObject({
      body: { status: "approval_cancelled" }
    });
    await expect(request.result).resolves.toMatchObject({ approved: false });
    expect(sideEffects).toBe(0);
    expect(fixture.operations.describeForConsole("operation-2").state).toBe("running");
    fixture.approvals.shutdown();
  });
});

function createFixture() {
  const scheduled: Array<() => void> = [];
  const clock = new Clock();
  const hub = new RuntimeRevisionHub({ schedule: (callback) => scheduled.push(callback) });
  let operationId = 0;
  let approvalId = 0;
  const operations = new OperationManager({ clock, idFactory: () => `operation-${++operationId}` });
  const approvals = new ApprovalCoordinator({
    client: { supportsFormElicitation: () => false, elicit: async () => ({ action: "cancel" }) },
    clock, idFactory: () => `approval-${++approvalId}`
  });
  const hosts = new HostRegistry([linux]);
  const sessions = new SessionManager({ idFactory: () => "session-1" });
  approvals.subscribe(() => hub.invalidate("approvals"));
  operations.subscribe(() => hub.invalidate("operations"));
  const projector = new RuntimeSnapshotProjector({
    instanceId: "instance-alpha", revisions: hub, hosts, operations, sessions, approvals
  });
  const routes = new ConsoleActionRoutes(
    { preview: () => { throw new Error("未使用命令预览"); } } as never,
    { preview: () => { throw new Error("未使用 Profile 预览"); } } as never,
    approvals,
    new OperationControlService(approvals, operations)
  );
  return {
    approvals, operations, routes, projector,
    flush: () => { while (scheduled.length > 0) scheduled.shift()!(); }
  };
}

function commandIntent(command: string) {
  return createOperationIntent({
    kind: "raw_command", hosts: ["linux"], platformByHost: { linux: "linux" }, payload: { command }
  });
}

const linux: HostConfig = {
  alias: "linux", environment: "test", platform: "linux", host: "linux.internal", port: 22,
  username: "secret", auth: { type: "privateKeyFile", path: "/secret/key" },
  shell: { type: "posix", command: "/bin/sh" }, remoteRoots: ["/secret/root"]
};
