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

  it("审批通道断链时不执行副作用", async () => {
    const client = new FakeApprovalClient(true);
    const service = new ApprovalService(client, new FakeClock());
    const sideEffects = new SideEffectProbe();
    const pending = service.execute(createOperationIntent(approvalIntentInput()), () => sideEffects.run());
    await Promise.resolve();
    client.reject(new Error("transport disconnected"));

    await expect(pending).resolves.toMatchObject({
      approved: false,
      error: {
        code: "APPROVAL_DECLINED",
        finalState: "failed",
        retriable: false,
        sideEffects: "none",
        details: { reason: "disconnected" }
      }
    });
    expect(sideEffects.calls).toBe(0);
  });

  it("客户端未声明 form elicitation 时明确拒绝且不请求、不执行", async () => {
    const client = new FakeApprovalClient(false);
    const service = new ApprovalService(client, new FakeClock());
    const sideEffects = new SideEffectProbe();

    await expect(service.execute(createOperationIntent(approvalIntentInput()), () => sideEffects.run()))
      .resolves.toMatchObject({
        approved: false,
        error: {
          code: "APPROVAL_UNSUPPORTED",
          finalState: "failed",
          retriable: false,
          sideEffects: "none"
        }
      });
    expect(client.forms).toHaveLength(0);
    expect(sideEffects.calls).toBe(0);
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
