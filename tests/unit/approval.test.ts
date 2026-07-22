import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testWithIds } from "../test-with-ids.js";
import {
  ApprovalService,
  type ApprovalClient,
  type ApprovalForm,
  type ApprovalResponse,
  type Clock
} from "../../src/approval/approval-service.js";
import {
  canonicalJson,
  createOperationIntent,
  type JsonValue,
  type OperationIntent
} from "../../src/approval/operation-intent.js";
import { OperationManager, type MonotonicClock } from "../../src/operations/operation-manager.js";
import {
  ApprovalCoordinator,
  type ApprovalSafeSnapshot
} from "../../src/approval/approval-coordinator.js";

describe("OperationIntent", () => {
  testWithIds(["SC-018", "SC-019"], "以稳定 canonical JSON、SHA-256 摘要和深冻结绑定完整操作", () => {
    const input = approvalIntentInput();
    const intent = createOperationIntent(input);

    expect(intent.canonicalJson).toBe(
      "{\"executionMode\":\"parallel\",\"hosts\":[\"alpha\"],\"kind\":\"upload\",\"payload\":{\"command\":\"cat /srv/source\",\"input\":\"confirmed\",\"overwrite\":false,\"recursive\":true,\"source\":\"/workspace/source\",\"target\":\"/srv/target\"},\"platformByHost\":{\"alpha\":\"linux\"}}"
    );
    expect(intent.digest).toBe(
      createHash("sha256").update(intent.canonicalJson, "utf8").digest("hex")
    );
    expect(Object.isFrozen(intent)).toBe(true);
    expect(Object.isFrozen(intent.hosts)).toBe(true);
    expect(Object.isFrozen(intent.platformByHost)).toBe(true);
    expect(Object.isFrozen(intent.payload)).toBe(true);

    input.payload.source = "/workspace/changed";
    expect(intent.payload.source).toBe("/workspace/source");
    expect(() => {
      (intent.payload as { source: string }).source = "/workspace/replaced";
    }).toThrow();
  });

  it.each([
    ["主机集合", (input: ReturnType<typeof approvalIntentInput>) => { input.hosts = ["beta"]; input.platformByHost = { beta: "linux" }; }],
    ["命令", (input: ReturnType<typeof approvalIntentInput>) => { input.payload.command = "cat /srv/other"; }],
    ["输入", (input: ReturnType<typeof approvalIntentInput>) => { input.payload.input = "different"; }],
    ["路径", (input: ReturnType<typeof approvalIntentInput>) => { input.payload.target = "/srv/other"; }],
    ["递归", (input: ReturnType<typeof approvalIntentInput>) => { input.payload.recursive = false; }],
    ["覆盖", (input: ReturnType<typeof approvalIntentInput>) => { input.payload.overwrite = true; }]
  ])("%s 变化时必须生成新摘要", (_name, change) => {
    const original = createOperationIntent(approvalIntentInput());
    const changed = approvalIntentInput();
    change(changed);

    expect(createOperationIntent(changed).digest).not.toBe(original.digest);
  });

  it("递归拒绝稀疏数组和 undefined，避免与合法数组发生 canonical 碰撞", () => {
    const sparse = Array(1);

    expect(canonicalJson([])).toBe("[]");
    expect(() => canonicalJson(sparse as unknown as JsonValue)).toThrow("稀疏数组");
    expect(() => canonicalJson({ nested: [sparse] } as unknown as JsonValue)).toThrow("稀疏数组");
    expect(() => canonicalJson({ nested: undefined } as unknown as JsonValue)).toThrow("undefined");
    expect(() => createOperationIntent({
      ...approvalIntentInput(),
      payload: { values: [sparse] }
    } as unknown as Parameters<typeof createOperationIntent>[0])).toThrow("稀疏数组");
  });
});

describe("ApprovalService", () => {
  it("审批服务独占超时结算，同一 operationId 的返回值与持久状态均为 timed_out", async () => {
    const client = new FakeApprovalClient(true);
    const clock = new SharedFakeClock();
    const manager = new OperationManager({
      clock,
      idFactory: () => "approval-timeout",
      limits: { approvalTimeoutMs: 10 }
    });
    const events: unknown[] = [];
    const service = new ApprovalService(client, clock, 10, manager, (event) => events.push(event));

    const pending = service.execute(createOperationIntent(approvalIntentInput()), () => "never");
    await Promise.resolve();
    clock.advance(10);

    await expect(pending).resolves.toMatchObject({
      approved: false,
      error: { operationId: "approval-timeout", code: "APPROVAL_TIMEOUT", finalState: "timed_out" }
    });
    expect(manager.get("approval-timeout")).toMatchObject({
      state: "timed_out",
      error: { operationId: "approval-timeout", code: "APPROVAL_TIMEOUT", finalState: "timed_out" }
    });
    expect(events).toEqual([expect.objectContaining({
      operationId: "approval-timeout", approved: false, state: "timed_out", errorCode: "APPROVAL_TIMEOUT"
    })]);
  });

  it("shutdown 会中止挂起审批并保证副作用为零，之后的新审批关闭失败", async () => {
    const client = new FakeApprovalClient(true);
    const service = new ApprovalService(client, new FakeClock());
    const sideEffects = new SideEffectProbe();
    const pending = service.execute(createOperationIntent(approvalIntentInput()), () => sideEffects.run());
    await Promise.resolve();
    service.shutdown();
    await expect(pending).resolves.toMatchObject({
      approved: false,
      error: { code: "APPROVAL_DECLINED", details: { reason: "disconnected" }, sideEffects: "none" }
    });
    await expect(service.execute(createOperationIntent(approvalIntentInput()), () => sideEffects.run()))
      .resolves.toMatchObject({ approved: false, error: { code: "APPROVAL_DECLINED", sideEffects: "none" } });
    expect(sideEffects.calls).toBe(0);
  });

  testWithIds(["SAFE-APPROVAL-001"], "展示同一 Intent 的完整信息，批准前不执行副作用，且批准只消费一次", async () => {
    const client = new FakeApprovalClient(true);
    const clock = new FakeClock();
    const service = new ApprovalService(client, clock);
    const sideEffects = new SideEffectProbe();
    const intent = createOperationIntent(approvalIntentInput());
    let executedIntent: OperationIntent | undefined;

    const pending = service.execute(intent, (approvedIntent) => {
      executedIntent = approvedIntent;
      return sideEffects.run(approvedIntent);
    });
    await Promise.resolve();

    expect(sideEffects.calls).toBe(0);
    expect(client.forms).toHaveLength(1);
    expect(client.forms[0]?.message).toContain("alpha");
    expect(client.forms[0]?.message).toContain("linux");
    expect(client.forms[0]?.message).toContain("cat /srv/source");
    expect(client.forms[0]?.message).toContain("confirmed");
    expect(client.forms[0]?.message).toContain("/workspace/source");
    expect(client.forms[0]?.message).toContain("/srv/target");
    expect(client.forms[0]?.message).toContain("\"recursive\":true");
    expect(client.forms[0]?.message).toContain("\"overwrite\":false");
    expect(client.forms[0]?.message).toContain(intent.digest);
    expect(client.forms[0]?.requestedSchema).toEqual({ type: "object", properties: {} });

    client.resolve({ action: "accept" });

    await expect(pending).resolves.toEqual({
      approved: true,
      intent,
      value: "executed"
    });
    expect(sideEffects.calls).toBe(1);
    expect(executedIntent).toBe(intent);
    expect(sideEffects.lastIntent).toBe(intent);
    expect(client.forms[0]?.message).toContain("影响摘要");
    expect(client.forms[0]?.message).toContain(executedIntent?.canonicalJson ?? "missing");
    expect(client.forms[0]?.message).toContain(executedIntent?.digest ?? "missing");
  });

  it("同一获批 Intent 不能被重放", async () => {
    const client = new FakeApprovalClient(true);
    const service = new ApprovalService(client, new FakeClock());
    const sideEffects = new SideEffectProbe();
    const intent = createOperationIntent(approvalIntentInput());
    const pending = service.execute(intent, (approvedIntent) => sideEffects.run(approvedIntent));
    await Promise.resolve();
    client.resolve({ action: "accept" });

    await expect(pending).resolves.toMatchObject({ approved: true, intent });
    await expect(service.execute(intent, (approvedIntent) => sideEffects.run(approvedIntent)))
      .resolves.toMatchObject(intentMismatchResult());
    expect(client.forms).toHaveLength(1);
    expect(sideEffects.calls).toBe(1);
  });

  it("拒绝结构完全相同但并非工厂产物的伪造 Intent，且不发起审批或副作用", async () => {
    const client = new FakeApprovalClient(true);
    const service = new ApprovalService(client, new FakeClock());
    const sideEffects = new SideEffectProbe();
    const realIntent = createOperationIntent(approvalIntentInput());
    const forgedIntent = Object.freeze({ ...realIntent }) as OperationIntent;

    await expect(service.execute(forgedIntent, (approvedIntent) => sideEffects.run(approvedIntent)))
      .resolves.toMatchObject(intentMismatchResult());
    expect(client.forms).toHaveLength(0);
    expect(sideEffects.calls).toBe(0);
  });

  it("审批展示后的 mutation 尝试会使完整性校验失败，批准也不执行副作用", async () => {
    const client = new FakeApprovalClient(true);
    const service = new ApprovalService(client, new FakeClock());
    const sideEffects = new SideEffectProbe();
    const intent = createOperationIntent(approvalIntentInput());
    const pending = service.execute(intent, (approvedIntent) => sideEffects.run(approvedIntent));
    await Promise.resolve();

    expect(client.forms).toHaveLength(1);
    expect(Reflect.set(intent.payload, "source", "/workspace/tampered")).toBe(false);
    expect(intent.payload.source).toBe("/workspace/source");
    client.resolve({ action: "accept" });

    await expect(pending).resolves.toMatchObject(intentMismatchResult());
    expect(sideEffects.calls).toBe(0);
  });

  it.each([
    ["canonical", { canonicalJson: "{}" }],
    ["digest", { digest: "0".repeat(64) }]
  ])("拒绝 %s 与获批语义不一致的 Intent", async (_name, replacement) => {
    const client = new FakeApprovalClient(true);
    const service = new ApprovalService(client, new FakeClock());
    const sideEffects = new SideEffectProbe();
    const intent = createOperationIntent(approvalIntentInput());
    const inconsistentIntent = Object.freeze({ ...intent, ...replacement }) as OperationIntent;

    await expect(service.execute(inconsistentIntent, (approvedIntent) => sideEffects.run(approvedIntent)))
      .resolves.toMatchObject(intentMismatchResult());
    expect(client.forms).toHaveLength(0);
    expect(sideEffects.calls).toBe(0);
  });

  it.each([
    ["拒绝", { action: "decline" } satisfies ApprovalResponse, "APPROVAL_DECLINED", "failed", undefined],
    ["取消", { action: "cancel" } satisfies ApprovalResponse, "APPROVAL_DECLINED", "failed", "cancelled"]
  ])("%s 时不执行副作用", async (_name, response, code, finalState, reason) => {
    const client = new FakeApprovalClient(true);
    const service = new ApprovalService(client, new FakeClock());
    const sideEffects = new SideEffectProbe();
    const pending = service.execute(createOperationIntent(approvalIntentInput()), () => sideEffects.run());
    await Promise.resolve();
    client.resolve(response);

    await expect(pending).resolves.toMatchObject({
      approved: false,
      error: {
        code,
        finalState,
        retriable: false,
        sideEffects: "none",
        ...(reason === undefined ? {} : { details: { reason } })
      }
    });
    expect(sideEffects.calls).toBe(0);
  });

  testWithIds(["SC-020"], "审批拒绝与两分钟超时均中止流程且副作用为零", async () => {
    const declinedClient = new FakeApprovalClient(true);
    const declinedSideEffects = new SideEffectProbe();
    const declined = new ApprovalService(declinedClient, new FakeClock()).execute(
      createOperationIntent(approvalIntentInput()),
      () => declinedSideEffects.run()
    );
    await Promise.resolve();
    declinedClient.resolve({ action: "decline" });
    await expect(declined).resolves.toMatchObject({
      approved: false,
      error: { code: "APPROVAL_DECLINED", finalState: "failed", retriable: false, sideEffects: "none" }
    });
    expect(declinedSideEffects.calls).toBe(0);

    const timeoutClient = new FakeApprovalClient(true);
    const clock = new FakeClock();
    const timeoutSideEffects = new SideEffectProbe();
    const timedOut = new ApprovalService(timeoutClient, clock).execute(
      createOperationIntent(approvalIntentInput()),
      () => timeoutSideEffects.run()
    );
    await Promise.resolve();
    clock.advance(120_000);
    await expect(timedOut).resolves.toMatchObject({
      approved: false,
      error: { code: "APPROVAL_TIMEOUT", finalState: "timed_out", retriable: false, sideEffects: "none" }
    });
    expect(timeoutClient.signal?.aborted).toBe(true);
    expect(timeoutSideEffects.calls).toBe(0);
  });

  it("MCP 审批通道断链时保留网页通道，最终仍由统一期限保守结算", async () => {
    const client = new FakeApprovalClient(true);
    const clock = new SharedFakeClock();
    const service = new ApprovalService(client, clock, 10);
    const sideEffects = new SideEffectProbe();
    const pending = service.execute(createOperationIntent(approvalIntentInput()), () => sideEffects.run());
    await Promise.resolve();
    client.reject(new Error("transport disconnected"));
    await Promise.resolve();

    expect(service.coordinator.list()).toEqual([
      expect.objectContaining({ state: "pending", mcpChannelState: "failed" })
    ]);
    clock.advance(10);
    await expect(pending).resolves.toMatchObject({
      approved: false,
      error: { code: "APPROVAL_TIMEOUT", finalState: "timed_out", sideEffects: "none" }
    });
    expect(sideEffects.calls).toBe(0);
  });

  it("把 awaiting Operation 的 operationId 传入审批安全快照", async () => {
    const client = new FakeApprovalClient(false);
    const manager = new OperationManager({ idFactory: () => "operation-awaiting" });
    const service = new ApprovalService(client, new FakeClock(), 120_000, manager);

    const pending = service.execute(createOperationIntent(approvalIntentInput()), () => "done");

    expect(service.coordinator.list()).toEqual([
      expect.objectContaining({ operationId: "operation-awaiting", state: "pending" })
    ]);
    service.coordinator.decide(service.coordinator.list()[0]!.approvalId, "decline");
    await pending;
  });

  it("结果订阅者异常不改变已完成的 Operation 与审批返回值", async () => {
    const client = new FakeApprovalClient(false);
    const manager = new OperationManager({ idFactory: () => "operation-result-listener" });
    const service = new ApprovalService(client, new FakeClock(), 120_000, manager, () => {
      throw new Error("result listener failed");
    });

    const pending = service.execute(createOperationIntent(approvalIntentInput()), () => "done");
    const approval = service.coordinator.list()[0]!;
    expect(() => service.coordinator.decide(approval.approvalId, "accept")).not.toThrow();

    await expect(pending).resolves.toMatchObject({ approved: true, value: "done" });
    expect(manager.get("operation-result-listener")).toMatchObject({ state: "completed" });
  });

  it("后台运行器接管后副作用 Promise 失败不再由审批层结算 Operation", async () => {
    const client = new FakeApprovalClient(false);
    const clock = new SharedFakeClock();
    const manager = new OperationManager({ clock, idFactory: () => "operation-background-owned" });
    const service = new ApprovalService(client, clock, 120_000, manager);
    let rejectAfterHandoff!: (error: Error) => void;
    const runner = { cancel: () => undefined };
    const pending = service.execute(createOperationIntent(approvalIntentInput()), (_intent, context) => {
      manager.attachRunner(context!.operationId!, runner, "command");
      context!.markBackground();
      return new Promise<never>((_resolve, reject) => { rejectAfterHandoff = reject; });
    });
    const approval = service.coordinator.list()[0]!;

    service.coordinator.decide(approval.approvalId, "accept");
    expect(manager.get("operation-background-owned")).toMatchObject({ state: "running" });
    rejectAfterHandoff(new Error("wrapper failed after handoff"));

    await expect(pending).resolves.toMatchObject({
      approved: false,
      error: { code: "STATE_UNKNOWN", finalState: "unknown", operationId: "operation-background-owned" }
    });
    expect(manager.get("operation-background-owned")).toMatchObject({ state: "running" });
    expect(manager.complete("operation-background-owned")).toMatchObject({ state: "completed" });
  });

  it("客户端未声明 form elicitation 时 dual 保留网页审批直到原期限，不请求、不执行", async () => {
    const client = new FakeApprovalClient(false);
    const clock = new FakeClock();
    const service = new ApprovalService(client, clock);
    const sideEffects = new SideEffectProbe();

    const pending = service.execute(createOperationIntent(approvalIntentInput()), () => sideEffects.run());
    await Promise.resolve();
    expect(client.forms).toHaveLength(0);
    clock.advance(120_000);
    await expect(pending)
      .resolves.toMatchObject({
        approved: false,
        error: {
          code: "APPROVAL_TIMEOUT",
          finalState: "timed_out",
          retriable: false,
          sideEffects: "none"
        }
      });
    expect(sideEffects.calls).toBe(0);
  });
});

describe("ApprovalCoordinator", () => {
  it("初始 onRevision 同步重入接受后不再启动孤立的 MCP elicitation", async () => {
    const client = new FakeApprovalClient(true);
    const sideEffects = new SideEffectProbe();
    let coordinator!: ApprovalCoordinator;
    coordinator = new ApprovalCoordinator({
      client,
      clock: new SharedFakeClock(),
      idFactory: () => "approval-reentrant-initial-revision",
      onRevision: (snapshot) => {
        if (snapshot.state === "pending") coordinator.decide(snapshot.approvalId, "accept");
      }
    });

    const request = coordinator.request(
      createOperationIntent(approvalIntentInput()),
      (intent) => sideEffects.run(intent)
    );

    await expect(request.result).resolves.toMatchObject({ approved: true, value: "executed" });
    expect(coordinator.get(request.approvalId)).toMatchObject({ state: "accepted", resolvedBy: "web" });
    expect(sideEffects.calls).toBe(1);
    expect(client.forms).toHaveLength(0);
    expect(client.signal).toBeUndefined();
  });

  it("非 Abort 的 MCP 异常只标记通道失败，网页仍可接受并执行一次", async () => {
    const client = new FakeApprovalClient(true);
    const coordinator = new ApprovalCoordinator({
      client,
      clock: new SharedFakeClock(),
      idFactory: () => "approval-mcp-channel-failed"
    });
    const sideEffects = new SideEffectProbe();
    const request = coordinator.request(
      createOperationIntent(approvalIntentInput()),
      (intent) => sideEffects.run(intent)
    );
    client.reject(new Error("secret transport failure"));
    await Promise.resolve();

    expect(coordinator.get(request.approvalId)).toMatchObject({
      state: "pending",
      mcpChannelState: "failed"
    });
    expect(coordinator.get(request.approvalId)).not.toHaveProperty("resolvedBy");
    expect(coordinator.decide(request.approvalId, "accept")).toMatchObject({
      status: "resolved",
      approval: { state: "accepted", resolvedBy: "web" }
    });
    await expect(request.result).resolves.toMatchObject({ approved: true, value: "executed" });
    expect(sideEffects.calls).toBe(1);
    expect(JSON.stringify(coordinator.get(request.approvalId))).not.toContain("secret transport failure");
  });

  it("onRevision 同步异常不会打断资源清理、Intent 消费、副作用或 Promise 结算", async () => {
    const client = new FakeApprovalClient(true);
    const clock = new SharedFakeClock();
    const sideEffects = new SideEffectProbe();
    const coordinator = new ApprovalCoordinator({
      client,
      clock,
      resultRetentionMs: 5,
      maxRecords: 1,
      idFactory: () => "approval-listener-failed",
      onRevision: () => { throw new Error("revision listener failed"); }
    });

    const request = coordinator.request(
      createOperationIntent(approvalIntentInput()),
      (intent) => sideEffects.run(intent)
    );
    expect(() => coordinator.decide(request.approvalId, "accept")).not.toThrow();
    await expect(request.result).resolves.toMatchObject({ approved: true, value: "executed" });
    expect(sideEffects.calls).toBe(1);
    expect(client.signal?.aborted).toBe(true);

    clock.advance(5);
    expect(coordinator.get(request.approvalId)).toBeUndefined();
  });

  it("安全快照包含脱离 Intent 的深冻结完整操作与影响摘要，不暴露 canonical JSON", () => {
    const coordinator = new ApprovalCoordinator({
      client: new FakeApprovalClient(false),
      clock: new SharedFakeClock(),
      idFactory: () => "approval-safe-view"
    });
    const intent = createOperationIntent(approvalIntentInput());
    const request = coordinator.request(intent, () => "done", { route: "web_only", operationId: "operation-safe-view" });
    const snapshot = coordinator.get(request.approvalId)!;

    expect(snapshot).toMatchObject({
      operationId: "operation-safe-view",
      safeView: {
        operation: {
          kind: intent.kind,
          hosts: intent.hosts,
          platformByHost: intent.platformByHost,
          payload: intent.payload,
          executionMode: intent.executionMode
        },
        impact: expect.any(String)
      }
    });
    expect(snapshot.safeView.operation).not.toBe(intent);
    expect(snapshot.safeView.operation.payload).not.toBe(intent.payload);
    expect(Object.isFrozen(snapshot.safeView)).toBe(true);
    expect(Object.isFrozen(snapshot.safeView.operation)).toBe(true);
    expect(Object.isFrozen(snapshot.safeView.operation.payload)).toBe(true);
    expect(snapshot).not.toHaveProperty("canonicalJson");
    expect(snapshot.safeView).not.toHaveProperty("canonicalJson");
  });

  it("网页快照与 MCP form 的影响摘要区分通道失败和保守终止", () => {
    const client = new FakeApprovalClient(true);
    const coordinator = new ApprovalCoordinator({
      client,
      clock: new SharedFakeClock(),
      idFactory: () => "approval-impact-summary"
    });
    const expectedImpact = "批准后会在所列主机上执行此精确操作一次；MCP 审批通道失败后，网页仍可在审批期限内决定；服务关闭、拒绝、取消或超时均不会执行。";
    const request = coordinator.request(createOperationIntent(approvalIntentInput()), () => "done");

    expect(coordinator.get(request.approvalId)?.safeView.impact).toBe(expectedImpact);
    expect(client.forms[0]?.message).toContain(`影响摘要：${expectedImpact}`);
  });

  it.each([
    ["maxRecords", 0],
    ["maxRecords", -1],
    ["maxRecords", 1.5],
    ["maxRecords", Number.NaN],
    ["maxRecords", Number.POSITIVE_INFINITY],
    ["maxRecords", Number.MAX_SAFE_INTEGER + 1],
    ["approvalTimeoutMs", 0],
    ["approvalTimeoutMs", -1],
    ["approvalTimeoutMs", 1.5],
    ["approvalTimeoutMs", Number.NaN],
    ["approvalTimeoutMs", Number.POSITIVE_INFINITY],
    ["approvalTimeoutMs", Number.MAX_SAFE_INTEGER + 1],
    ["resultRetentionMs", 0],
    ["resultRetentionMs", -1],
    ["resultRetentionMs", 1.5],
    ["resultRetentionMs", Number.NaN],
    ["resultRetentionMs", Number.POSITIVE_INFINITY],
    ["resultRetentionMs", Number.MAX_SAFE_INTEGER + 1]
  ] as const)("拒绝非法协调器选项 %s=%s", (name, value) => {
    expect(() => new ApprovalCoordinator({
      client: new FakeApprovalClient(false),
      [name]: value
    })).toThrow(RangeError);
  });

  it("接受最小正安全整数的容量与期限", () => {
    expect(() => new ApprovalCoordinator({
      client: new FakeApprovalClient(false),
      maxRecords: 1,
      approvalTimeoutMs: 1,
      resultRetentionMs: 1
    })).not.toThrow();
  });

  it.each([
    ["maxRecords", 65],
    ["maxRecords", Number.MAX_SAFE_INTEGER],
    ["approvalTimeoutMs", 600_001],
    ["approvalTimeoutMs", 2_147_483_648],
    ["approvalTimeoutMs", Number.MAX_SAFE_INTEGER],
    ["resultRetentionMs", 3_600_001],
    ["resultRetentionMs", 2_147_483_648],
    ["resultRetentionMs", Number.MAX_SAFE_INTEGER]
  ] as const)("拒绝超过项目资源预算的协调器选项 %s=%s", (name, value) => {
    expect(() => new ApprovalCoordinator({
      client: new FakeApprovalClient(false),
      [name]: value
    })).toThrow(RangeError);
  });

  it("接受与项目资源预算一致的容量与期限上限", () => {
    expect(() => new ApprovalCoordinator({
      client: new FakeApprovalClient(false),
      maxRecords: 64,
      approvalTimeoutMs: 600_000,
      resultRetentionMs: 3_600_000
    })).not.toThrow();
  });

  testWithIds(["LC-SC-027"],
    "web-first 同步接受唯一生效，中止 MCP，其他标签页稳定返回 already_resolved", async () => {
    const client = new FakeApprovalClient(true);
    const clock = new SharedFakeClock();
    const revisions: ApprovalSafeSnapshot[] = [];
    const coordinator = new ApprovalCoordinator({
      client,
      clock,
      approvalTimeoutMs: 100,
      resultRetentionMs: 50,
      idFactory: () => "approval-web-first",
      onRevision: (snapshot) => revisions.push(snapshot)
    });
    const sideEffects = new SideEffectProbe();
    const request = coordinator.request(
      createOperationIntent(approvalIntentInput()),
      (intent) => sideEffects.run(intent),
      { route: "dual" }
    );

    expect(coordinator.get(request.approvalId)).toMatchObject({
      approvalId: "approval-web-first",
      route: "dual",
      state: "pending",
      revision: 1
    });
    expect(sideEffects.calls).toBe(0);
    expect(client.forms).toHaveLength(1);

    expect(coordinator.decide(request.approvalId, "accept")).toMatchObject({
      status: "resolved",
      approval: { state: "accepted", resolvedBy: "web" }
    });
    expect(sideEffects.calls).toBe(1);
    expect(client.signal?.aborted).toBe(true);
    expect(coordinator.decide(request.approvalId, "decline")).toMatchObject({
      status: "already_resolved",
      approval: { state: "accepted", resolvedBy: "web" }
    });
    await expect(request.result).resolves.toMatchObject({ approved: true, value: "executed" });
    expect(revisions.at(-1)).toMatchObject({ state: "accepted", resolvedBy: "web" });
  });

  testWithIds(["LC-SC-028"], "MCP-first 发布已处理 revision，后到网页决定不能改变结果", async () => {
    const client = new FakeApprovalClient(true);
    const revisions: ApprovalSafeSnapshot[] = [];
    const coordinator = new ApprovalCoordinator({
      client,
      clock: new SharedFakeClock(),
      idFactory: () => "approval-mcp-first",
      onRevision: (snapshot) => revisions.push(snapshot)
    });
    const sideEffects = new SideEffectProbe();
    const request = coordinator.request(
      createOperationIntent(approvalIntentInput()),
      (intent) => sideEffects.run(intent)
    );

    client.resolve({ action: "accept" });
    await expect(request.result).resolves.toMatchObject({ approved: true });
    expect(sideEffects.calls).toBe(1);
    expect(revisions.at(-1)).toMatchObject({ state: "accepted", resolvedBy: "mcp", revision: 2 });
    expect(coordinator.decide(request.approvalId, "cancel")).toMatchObject({
      status: "already_resolved",
      approval: { state: "accepted", resolvedBy: "mcp" }
    });
    expect(sideEffects.calls).toBe(1);
  });

  it.each([
    ["web accept", "web", "accept", "accepted", 1],
    ["web decline", "web", "decline", "declined", 0],
    ["web cancel", "web", "cancel", "cancelled", 0],
    ["MCP accept", "mcp", "accept", "accepted", 1],
    ["MCP decline", "mcp", "decline", "declined", 0],
    ["MCP cancel", "mcp", "cancel", "cancelled", 0],
    ["timeout", "timeout", "cancel", "timed_out", 0],
    ["shutdown", "shutdown", "cancel", "cancelled", 0]
  ] as const)("%s 首先结算后，后到网页接受始终无效", async (_name, source, action, state, calls) => {
    const client = new FakeApprovalClient(true);
    const clock = new SharedFakeClock();
    const coordinator = new ApprovalCoordinator({
      client,
      clock,
      approvalTimeoutMs: 10,
      idFactory: () => `approval-race-${source}-${action}`
    });
    const sideEffects = new SideEffectProbe();
    const request = coordinator.request(
      createOperationIntent(approvalIntentInput()),
      (intent) => sideEffects.run(intent)
    );

    if (source === "web") coordinator.decide(request.approvalId, action);
    else if (source === "mcp") {
      client.resolve({ action });
      await Promise.resolve();
    } else if (source === "timeout") clock.advance(10);
    else coordinator.shutdown();

    if (source === "shutdown") {
      expect(coordinator.get(request.approvalId)).toBeUndefined();
      expect(coordinator.decide(request.approvalId, "accept")).toEqual({ status: "not_found" });
    } else {
      expect(coordinator.get(request.approvalId)?.state).toBe(state);
      expect(coordinator.decide(request.approvalId, "accept")).toMatchObject({ status: "already_resolved" });
    }
    await request.result;
    expect(sideEffects.calls).toBe(calls);
  });

  testWithIds(["LC-SC-031", "LC-SC-032"],
    "web_only 不调用 MCP；dual 在客户端不支持 form 时仍于原期限等待网页", async () => {
    const client = new FakeApprovalClient(false);
    const clock = new SharedFakeClock();
    let sequence = 0;
    const coordinator = new ApprovalCoordinator({
      client,
      clock,
      approvalTimeoutMs: 20,
      idFactory: () => `approval-route-${sequence++}`
    });
    const webOnlyEffects = new SideEffectProbe();
    const webOnly = coordinator.request(
      createOperationIntent(approvalIntentInput()),
      (intent) => webOnlyEffects.run(intent),
      { route: "web_only" }
    );
    expect(client.forms).toHaveLength(0);
    coordinator.decide(webOnly.approvalId, "accept");
    await expect(webOnly.result).resolves.toMatchObject({ approved: true });
    expect(webOnlyEffects.calls).toBe(1);

    const dualEffects = new SideEffectProbe();
    const dual = coordinator.request(
      createOperationIntent(approvalIntentInput()),
      (intent) => dualEffects.run(intent),
      { route: "dual" }
    );
    await Promise.resolve();
    expect(client.forms).toHaveLength(0);
    expect(coordinator.get(dual.approvalId)?.state).toBe("pending");
    clock.advance(20);
    await expect(dual.result).resolves.toMatchObject({
      approved: false,
      error: { code: "APPROVAL_TIMEOUT", finalState: "timed_out", sideEffects: "none" }
    });
    expect(dualEffects.calls).toBe(0);
  });

  it.each([
    ["decline", "declined", undefined],
    ["cancel", "cancelled", "cancelled"]
  ] as const)("网页 %s 得到独立终态且副作用为零", async (action, state, reason) => {
    const coordinator = new ApprovalCoordinator({
      client: new FakeApprovalClient(false),
      clock: new SharedFakeClock(),
      idFactory: () => `approval-${action}`
    });
    const sideEffects = new SideEffectProbe();
    const request = coordinator.request(
      createOperationIntent(approvalIntentInput()),
      (intent) => sideEffects.run(intent)
    );

    expect(coordinator.decide(request.approvalId, action)).toMatchObject({
      status: "resolved",
      approval: { state, resolvedBy: "web" }
    });
    await expect(request.result).resolves.toMatchObject({
      approved: false,
      error: {
        code: "APPROVAL_DECLINED",
        sideEffects: "none",
        ...(reason === undefined ? {} : { details: { reason } })
      }
    });
    expect(sideEffects.calls).toBe(0);
  });

  it("shutdown 结算全部 pending 并清理所有记录与期限/保留期 timer，重复调用幂等", async () => {
    const client = new FakeApprovalClient(true);
    const clock = new SharedFakeClock();
    let sequence = 0;
    const coordinator = new ApprovalCoordinator({
      client,
      clock,
      resultRetentionMs: 900_000,
      idFactory: () => `approval-shutdown-${sequence++}`
    });
    const acceptedEffects = new SideEffectProbe();
    const accepted = coordinator.request(
      createOperationIntent(approvalIntentInput()),
      (intent) => acceptedEffects.run(intent),
      { route: "web_only" }
    );
    coordinator.decide(accepted.approvalId, "accept");
    await expect(accepted.result).resolves.toMatchObject({ approved: true, value: "executed" });

    const pendingEffects = new SideEffectProbe();
    const pending = coordinator.request(
      createOperationIntent(approvalIntentInput()),
      (intent) => pendingEffects.run(intent)
    );
    expect(coordinator.list()).toHaveLength(2);
    expect(clock.activeTimerCount).toBe(2);

    coordinator.shutdown();
    await expect(pending.result).resolves.toMatchObject({
      approved: false,
      error: { code: "APPROVAL_DECLINED", details: { reason: "disconnected" }, sideEffects: "none" }
    });
    expect(coordinator.list()).toEqual([]);
    expect(clock.activeTimerCount).toBe(0);
    expect(acceptedEffects.calls).toBe(1);
    expect(pendingEffects.calls).toBe(0);

    coordinator.shutdown();
    expect(coordinator.list()).toEqual([]);
    expect(clock.activeTimerCount).toBe(0);
    const after = coordinator.request(
      createOperationIntent(approvalIntentInput()),
      (intent) => pendingEffects.run(intent)
    );
    await expect(after.result).resolves.toMatchObject({
      approved: false,
      error: { code: "APPROVAL_DECLINED", details: { reason: "disconnected" }, sideEffects: "none" }
    });
    expect(pendingEffects.calls).toBe(0);
  });

  it("执行异常收敛为安全 failed 状态，不泄露原始异常或命令", async () => {
    const secret = "never expose: rm -rf /sensitive";
    const coordinator = new ApprovalCoordinator({
      client: new FakeApprovalClient(false),
      clock: new SharedFakeClock(),
      idFactory: () => "approval-execution-failed"
    });
    const request = coordinator.request(
      createOperationIntent(approvalIntentInput()),
      () => { throw new Error(secret); },
      { route: "web_only" }
    );

    coordinator.decide(request.approvalId, "accept");
    const result = await request.result;
    expect(result).toMatchObject({
      approved: false,
      error: { code: "STATE_UNKNOWN", finalState: "unknown", sideEffects: "possible" }
    });
    expect(coordinator.get(request.approvalId)).toMatchObject({ state: "failed", resolvedBy: "web" });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(coordinator.get(request.approvalId))).toContain("cat /srv/source");
    expect(JSON.stringify(coordinator.get(request.approvalId))).not.toContain(secret);
  });

  it("resolved 仅保留 resultRetentionMs，快照深冻结且记录总量有界", async () => {
    const clock = new SharedFakeClock();
    let sequence = 0;
    const coordinator = new ApprovalCoordinator({
      client: new FakeApprovalClient(false),
      clock,
      resultRetentionMs: 30,
      maxRecords: 1,
      idFactory: () => `approval-retention-${sequence++}`
    });
    const request = coordinator.request(
      createOperationIntent(approvalIntentInput()),
      () => "done",
      { route: "web_only" }
    );
    const snapshot = coordinator.get(request.approvalId)!;
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.hosts)).toBe(true);
    expect(snapshot).not.toHaveProperty("intent");
    expect(snapshot).not.toHaveProperty("sideEffect");
    expect(snapshot).not.toHaveProperty("canonicalJson");

    const overflow = coordinator.request(
      createOperationIntent(approvalIntentInput()),
      () => "never",
      { route: "web_only" }
    );
    await expect(overflow.result).resolves.toMatchObject({
      approved: false,
      error: { code: "RESOURCE_LIMIT", sideEffects: "none" }
    });
    expect(coordinator.list()).toHaveLength(1);

    coordinator.decide(request.approvalId, "accept");
    await request.result;
    clock.advance(29);
    expect(coordinator.get(request.approvalId)).toBeDefined();
    clock.advance(1);
    expect(coordinator.get(request.approvalId)).toBeUndefined();
  });

  it("接受时再次核验并一次消费 Intent，重放不能产生第二次副作用", async () => {
    const coordinator = new ApprovalCoordinator({
      client: new FakeApprovalClient(false),
      clock: new SharedFakeClock(),
      idFactory: () => "approval-intent-once"
    });
    const intent = createOperationIntent(approvalIntentInput());
    const sideEffects = new SideEffectProbe();
    const first = coordinator.request(intent, (approved) => sideEffects.run(approved), { route: "web_only" });
    coordinator.decide(first.approvalId, "accept");
    await expect(first.result).resolves.toMatchObject({ approved: true });

    const replay = coordinator.request(intent, (approved) => sideEffects.run(approved), { route: "web_only" });
    await expect(replay.result).resolves.toMatchObject(intentMismatchResult());
    expect(sideEffects.calls).toBe(1);
  });
});

function approvalIntentInput() {
  return {
    kind: "upload" as const,
    hosts: ["alpha"],
    platformByHost: { alpha: "linux" as const },
    payload: {
      command: "cat /srv/source",
      input: "confirmed",
      source: "/workspace/source",
      target: "/srv/target",
      recursive: true,
      overwrite: false
    },
    executionMode: "parallel" as const
  };
}

class FakeApprovalClient implements ApprovalClient {
  public readonly forms: ApprovalForm[] = [];
  public signal: AbortSignal | undefined;
  private settle: ((response: ApprovalResponse) => void) | undefined;
  private fail: ((error: Error) => void) | undefined;

  public constructor(private readonly formSupported: boolean) {}

  public supportsFormElicitation(): boolean {
    return this.formSupported;
  }

  public elicit(form: ApprovalForm, signal: AbortSignal): Promise<ApprovalResponse> {
    this.forms.push(form);
    this.signal = signal;
    return new Promise((resolve, reject) => {
      this.settle = resolve;
      this.fail = reject;
    });
  }

  public resolve(response: ApprovalResponse): void {
    this.settle?.(response);
  }

  public reject(error: Error): void {
    this.fail?.(error);
  }
}

class FakeClock implements Clock {
  private readonly timers = new Map<number, () => void>();
  private nextTimerId = 1;

  public setTimeout(callback: () => void, _delayMs: number): number {
    const timerId = this.nextTimerId;
    this.nextTimerId += 1;
    this.timers.set(timerId, callback);
    return timerId;
  }

  public clearTimeout(timerId: number): void {
    this.timers.delete(timerId);
  }

  public advance(_milliseconds: number): void {
    for (const [timerId, callback] of this.timers) {
      this.timers.delete(timerId);
      callback();
    }
  }
}

class SharedFakeClock implements Clock, MonotonicClock {
  private nowMs = 0;
  private nextTimerId = 1;
  private readonly timers = new Map<number, { due: number; callback: () => void }>();

  public get activeTimerCount(): number { return this.timers.size; }
  public now(): number { return this.nowMs; }
  public setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextTimerId++;
    this.timers.set(id, { due: this.nowMs + delayMs, callback });
    return id;
  }
  public clearTimeout(timer: unknown): void { this.timers.delete(timer as number); }
  public advance(milliseconds: number): void {
    this.nowMs += milliseconds;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.due <= this.nowMs);
      if (due.length === 0) return;
      for (const [id, timer] of due) { this.timers.delete(id); timer.callback(); }
    }
  }
}

class SideEffectProbe {
  public calls = 0;
  public lastIntent: OperationIntent | undefined;

  public run(intent?: OperationIntent): string {
    this.calls += 1;
    this.lastIntent = intent;
    return "executed";
  }
}

function intentMismatchResult() {
  return {
    approved: false,
    error: {
      code: "APPROVAL_INTENT_MISMATCH",
      finalState: "failed",
      retriable: false,
      sideEffects: "none"
    }
  } as const;
}
