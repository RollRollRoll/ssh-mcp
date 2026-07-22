import { randomUUID } from "node:crypto";
import type { ElicitRequestFormParams } from "@modelcontextprotocol/sdk/types.js";
import { ErrorCodes, createMcpOperationError, type McpOperationError } from "../errors/error-contract.js";
import {
  consumeVerifiedOperationIntent,
  isVerifiedOperationIntent,
  type OperationIntent
} from "./operation-intent.js";

export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
export const DEFAULT_APPROVAL_RESULT_RETENTION_MS = 900_000;
export const MAX_APPROVAL_TIMEOUT_MS = 600_000;
export const MAX_APPROVAL_RESULT_RETENTION_MS = 3_600_000;
export const MAX_APPROVAL_RECORDS = 64;
export const DEFAULT_MAX_APPROVAL_RECORDS = MAX_APPROVAL_RECORDS;

export type ApprovalRoute = "dual" | "web_only";
export type ApprovalAction = "accept" | "decline" | "cancel";
export type ApprovalState = "pending" | "accepted" | "declined" | "cancelled" | "timed_out" | "failed";
export type ApprovalResolutionSource = "web" | "mcp" | "timeout" | "shutdown";

export interface ApprovalClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
  now?(): number;
}

export interface ApprovalForm {
  readonly mode: "form";
  readonly message: string;
  readonly requestedSchema: ElicitRequestFormParams["requestedSchema"];
  readonly timeoutMs: number;
}

export interface ApprovalResponse {
  readonly action: ApprovalAction;
}

export interface ApprovalClient {
  supportsFormElicitation(): boolean;
  elicit(form: ApprovalForm, signal: AbortSignal): Promise<ApprovalResponse>;
}

export type ApprovalExecution<T> =
  | { readonly approved: true; readonly intent: OperationIntent; readonly value: T }
  | { readonly approved: false; readonly error: McpOperationError };

export interface ApprovalSafeSnapshot {
  readonly approvalId: string;
  readonly operationId?: string;
  readonly revision: number;
  readonly route: ApprovalRoute;
  readonly state: ApprovalState;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly kind: OperationIntent["kind"];
  readonly digest: string;
  readonly hosts: readonly string[];
  readonly platformByHost: Readonly<Record<string, OperationIntent["platformByHost"][string]>>;
  readonly safeView: ApprovalSafeView;
  readonly mcpChannelState?: "pending" | "failed" | "closed";
  readonly resolvedAt?: number;
  readonly resolvedBy?: ApprovalResolutionSource;
  readonly errorCode?: McpOperationError["code"];
}

export interface ApprovalSafeView {
  readonly operation: {
    readonly kind: OperationIntent["kind"];
    readonly hosts: readonly string[];
    readonly platformByHost: Readonly<Record<string, OperationIntent["platformByHost"][string]>>;
    readonly payload: OperationIntent["payload"];
    readonly executionMode?: OperationIntent["executionMode"];
  };
  readonly impact: string;
}

export interface ApprovalRequest<T> {
  readonly approvalId: string;
  readonly result: Promise<ApprovalExecution<T>>;
}

export interface ApprovalRequestOptions {
  readonly route?: ApprovalRoute;
  readonly operationId?: string;
}

export type ApprovalDecisionResult =
  | { readonly status: "resolved" | "already_resolved"; readonly approval: ApprovalSafeSnapshot }
  | { readonly status: "not_found" };

export interface ApprovalCoordinatorOptions {
  readonly client: ApprovalClient;
  readonly clock?: ApprovalClock;
  readonly approvalTimeoutMs?: number;
  readonly resultRetentionMs?: number;
  readonly maxRecords?: number;
  readonly idFactory?: () => string;
  readonly onRevision?: (snapshot: ApprovalSafeSnapshot) => void;
}

interface ApprovalRecord {
  snapshot: ApprovalSafeSnapshot;
  timeoutTimer: unknown;
  retentionTimer?: unknown;
  controller?: AbortController;
}

interface PendingSecret {
  readonly intent: OperationIntent;
  readonly sideEffect: (intent: OperationIntent) => unknown | Promise<unknown>;
  readonly resolve: (result: ApprovalExecution<unknown>) => void;
}

/**
 * MCP、网页、期限与关闭共用同一个同步仲裁点。公开记录只包含安全投影，
 * Intent 和副作用闭包仅在 pending 期间保存在独立表中，结算时立即释放。
 */
export class ApprovalCoordinator {
  private readonly client: ApprovalClient;
  private readonly clock: ApprovalClock;
  private readonly approvalTimeoutMs: number;
  private readonly resultRetentionMs: number;
  private readonly maxRecords: number;
  private readonly idFactory: () => string;
  private readonly onRevision?: (snapshot: ApprovalSafeSnapshot) => void;
  private readonly records = new Map<string, ApprovalRecord>();
  private readonly pending = new Map<string, PendingSecret>();
  private shuttingDown = false;

  public constructor(options: ApprovalCoordinatorOptions) {
    this.client = options.client;
    this.clock = options.clock ?? systemClock;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.resultRetentionMs = options.resultRetentionMs ?? DEFAULT_APPROVAL_RESULT_RETENTION_MS;
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_APPROVAL_RECORDS;
    assertPositiveIntegerWithin(this.approvalTimeoutMs, "approvalTimeoutMs", MAX_APPROVAL_TIMEOUT_MS);
    assertPositiveIntegerWithin(this.resultRetentionMs, "resultRetentionMs", MAX_APPROVAL_RESULT_RETENTION_MS);
    assertPositiveIntegerWithin(this.maxRecords, "maxRecords", MAX_APPROVAL_RECORDS);
    this.idFactory = options.idFactory ?? randomUUID;
    this.onRevision = options.onRevision;
  }

  public request<T>(
    intent: OperationIntent,
    sideEffect: (approvedIntent: OperationIntent) => T | Promise<T>,
    options: ApprovalRequestOptions = {}
  ): ApprovalRequest<T> {
    const approvalId = this.idFactory();
    if (!isVerifiedOperationIntent(intent)) {
      return { approvalId, result: Promise.resolve(intentMismatchResult()) };
    }
    if (this.shuttingDown) {
      return { approvalId, result: Promise.resolve(disconnectedResult()) };
    }
    if (this.records.size >= this.maxRecords || this.records.has(approvalId)) {
      return { approvalId, result: Promise.resolve(resourceLimitResult()) };
    }

    const route = options.route ?? "dual";
    const useMcpChannel = route === "dual" && this.client.supportsFormElicitation();
    const createdAt = this.now();
    let resolveResult!: (result: ApprovalExecution<T>) => void;
    const result = new Promise<ApprovalExecution<T>>((resolve) => { resolveResult = resolve; });
    const snapshot = safeSnapshot({
      approvalId,
      ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
      revision: 1,
      route,
      state: "pending",
      createdAt,
      expiresAt: createdAt + this.approvalTimeoutMs,
      kind: intent.kind,
      digest: intent.digest,
      hosts: intent.hosts,
      platformByHost: intent.platformByHost,
      safeView: createApprovalSafeView(intent),
      ...(useMcpChannel ? { mcpChannelState: "pending" as const } : {})
    });
    const record: ApprovalRecord = {
      snapshot,
      timeoutTimer: this.clock.setTimeout(() => this.timeout(approvalId), this.approvalTimeoutMs)
    };
    this.records.set(approvalId, record);
    this.pending.set(approvalId, {
      intent,
      sideEffect,
      resolve: (execution) => resolveResult(execution as ApprovalExecution<T>)
    });
    this.publish(snapshot);

    if (useMcpChannel && record.snapshot.state === "pending" && this.pending.has(approvalId)) {
      const controller = new AbortController();
      record.controller = controller;
      void this.elicit(approvalId, intent, controller);
    }
    return { approvalId, result };
  }

  public execute<T>(
    intent: OperationIntent,
    sideEffect: (approvedIntent: OperationIntent) => T | Promise<T>,
    options: ApprovalRequestOptions = {}
  ): Promise<ApprovalExecution<T>> {
    return this.request(intent, sideEffect, options).result;
  }

  public decide(approvalId: string, action: ApprovalAction): ApprovalDecisionResult {
    return this.settle(approvalId, action, "web");
  }

  /** pending 检查、首个终态赋值和 Intent 消费之间没有异步边界。 */
  public settle(
    approvalId: string,
    action: ApprovalAction,
    source: "web" | "mcp"
  ): ApprovalDecisionResult {
    const record = this.records.get(approvalId);
    if (record === undefined) return { status: "not_found" };
    if (record.snapshot.state !== "pending") {
      return { status: "already_resolved", approval: record.snapshot };
    }

    if (action === "accept") {
      return this.accept(record, source);
    }
    const state = action === "decline" ? "declined" : "cancelled";
    const error = approvalDeclinedError(action === "cancel" ? "cancelled" : undefined);
    this.resolvePending(record, state, source, error);
    return { status: "resolved", approval: record.snapshot };
  }

  public get(approvalId: string): ApprovalSafeSnapshot | undefined {
    return this.records.get(approvalId)?.snapshot;
  }

  public list(): readonly ApprovalSafeSnapshot[] {
    return Object.freeze([...this.records.values()].map((record) => record.snapshot));
  }

  public shutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const record of [...this.records.values()]) {
      if (record.snapshot.state === "pending") {
        this.resolvePending(record, "cancelled", "shutdown", approvalDeclinedError("disconnected"));
      }
    }
    for (const record of this.records.values()) this.releaseRecordResources(record);
    this.pending.clear();
    this.records.clear();
  }

  private accept(record: ApprovalRecord, source: "web" | "mcp"): ApprovalDecisionResult {
    const secret = this.pending.get(record.snapshot.approvalId);
    this.update(record, "accepted", source);
    this.releasePendingResources(record);

    if (secret === undefined || !consumeVerifiedOperationIntent(secret.intent)) {
      const error = intentMismatchError();
      this.update(record, "failed", source, error.code);
      this.pending.delete(record.snapshot.approvalId);
      this.scheduleRetention(record);
      secret?.resolve({ approved: false, error });
      return { status: "resolved", approval: record.snapshot };
    }
    this.pending.delete(record.snapshot.approvalId);
    this.scheduleRetention(record);

    let execution: unknown | Promise<unknown>;
    try {
      execution = secret.sideEffect(secret.intent);
    } catch {
      this.executionFailed(record, secret.resolve);
      return { status: "resolved", approval: record.snapshot };
    }
    Promise.resolve(execution).then(
      (value) => secret.resolve({ approved: true, intent: secret.intent, value }),
      () => this.executionFailed(record, secret.resolve)
    );
    return { status: "resolved", approval: record.snapshot };
  }

  private executionFailed(
    record: ApprovalRecord,
    resolve: (result: ApprovalExecution<unknown>) => void
  ): void {
    const error = executionFailureError();
    this.update(record, "failed", record.snapshot.resolvedBy ?? "web", error.code);
    resolve({ approved: false, error });
  }

  private timeout(approvalId: string): void {
    const record = this.records.get(approvalId);
    if (record === undefined || record.snapshot.state !== "pending") return;
    this.resolvePending(record, "timed_out", "timeout", approvalTimeoutError());
  }

  private async elicit(approvalId: string, intent: OperationIntent, controller: AbortController): Promise<void> {
    try {
      const response = await this.client.elicit(createApprovalForm(intent, this.approvalTimeoutMs), controller.signal);
      this.settle(approvalId, response.action, "mcp");
    } catch {
      if (controller.signal.aborted) return;
      const record = this.records.get(approvalId);
      if (record !== undefined && record.snapshot.state === "pending") {
        record.controller = undefined;
        record.snapshot = safeSnapshot({
          ...record.snapshot,
          revision: record.snapshot.revision + 1,
          mcpChannelState: "failed"
        });
        this.publish(record.snapshot);
      }
    }
  }

  private resolvePending(
    record: ApprovalRecord,
    state: Exclude<ApprovalState, "pending" | "accepted">,
    source: ApprovalResolutionSource,
    error: McpOperationError
  ): void {
    const secret = this.pending.get(record.snapshot.approvalId);
    this.update(record, state, source, error.code);
    this.releasePendingResources(record);
    this.pending.delete(record.snapshot.approvalId);
    this.scheduleRetention(record);
    secret?.resolve({ approved: false, error });
  }

  private releasePendingResources(record: ApprovalRecord): void {
    this.clock.clearTimeout(record.timeoutTimer);
    record.controller?.abort();
    record.controller = undefined;
  }

  private releaseRecordResources(record: ApprovalRecord): void {
    this.releasePendingResources(record);
    if (record.retentionTimer !== undefined) {
      this.clock.clearTimeout(record.retentionTimer);
      record.retentionTimer = undefined;
    }
  }

  private scheduleRetention(record: ApprovalRecord): void {
    if (this.shuttingDown || record.retentionTimer !== undefined) return;
    record.retentionTimer = this.clock.setTimeout(() => {
      this.records.delete(record.snapshot.approvalId);
    }, this.resultRetentionMs);
  }

  private update(
    record: ApprovalRecord,
    state: ApprovalState,
    resolvedBy: ApprovalResolutionSource,
    errorCode?: McpOperationError["code"]
  ): void {
    record.snapshot = safeSnapshot({
      ...record.snapshot,
      revision: record.snapshot.revision + 1,
      state,
      resolvedAt: record.snapshot.resolvedAt ?? this.now(),
      resolvedBy,
      ...(record.snapshot.mcpChannelState === undefined ? {} : { mcpChannelState: "closed" as const }),
      ...(errorCode === undefined ? {} : { errorCode })
    });
    this.publish(record.snapshot);
  }

  private publish(snapshot: ApprovalSafeSnapshot): void {
    try {
      this.onRevision?.(snapshot);
    } catch {
      // 观察者不属于审批状态机，异常不得影响状态提交与敏感资源释放。
    }
  }

  private now(): number {
    return this.clock.now?.() ?? Date.now();
  }
}

export function createApprovalForm(intent: OperationIntent, timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS): ApprovalForm {
  const safeView = createApprovalSafeView(intent);
  return Object.freeze({
    mode: "form" as const,
    message: [
      "操作授权请求",
      `目标主机（按顺序）：${JSON.stringify(safeView.operation.hosts)}`,
      `主机平台：${JSON.stringify(safeView.operation.platformByHost)}`,
      "完整操作（canonical JSON）：",
      intent.canonicalJson,
      `影响摘要：${safeView.impact}`,
      `SHA-256 摘要：${intent.digest}`,
      "仅接受会执行该精确操作一次。"
    ].join("\n"),
    requestedSchema: { type: "object", properties: {} } as ElicitRequestFormParams["requestedSchema"],
    timeoutMs
  });
}

const systemClock: ApprovalClock = {
  setTimeout: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  },
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
  now: () => Date.now()
};

function safeSnapshot(snapshot: ApprovalSafeSnapshot): ApprovalSafeSnapshot {
  return Object.freeze({
    ...snapshot,
    hosts: Object.freeze([...snapshot.hosts]),
    platformByHost: Object.freeze({ ...snapshot.platformByHost }),
    safeView: cloneApprovalSafeView(snapshot.safeView)
  });
}

function createApprovalSafeView(intent: OperationIntent): ApprovalSafeView {
  return cloneApprovalSafeView({
    operation: {
      kind: intent.kind,
      hosts: intent.hosts,
      platformByHost: intent.platformByHost,
      payload: intent.payload,
      ...(intent.executionMode === undefined ? {} : { executionMode: intent.executionMode })
    },
    impact: "批准后会在所列主机上执行此精确操作一次；MCP 审批通道失败后，网页仍可在审批期限内决定；服务关闭、拒绝、取消或超时均不会执行。"
  });
}

function cloneApprovalSafeView(view: ApprovalSafeView): ApprovalSafeView {
  return deepFreezeClone(view) as ApprovalSafeView;
}

function deepFreezeClone(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => deepFreezeClone(item)));
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, deepFreezeClone(child)])
  ));
}

function assertPositiveIntegerWithin(value: number, name: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${name} 必须是 1 到 ${maximum} 的整数`);
  }
}

function approvalDeclinedError(reason?: "cancelled" | "disconnected"): McpOperationError {
  return createMcpOperationError({
    code: ErrorCodes.APPROVAL_DECLINED,
    message: ErrorCodes.APPROVAL_DECLINED,
    finalState: "failed",
    retriable: false,
    sideEffects: "none",
    ...(reason === undefined ? {} : { details: { reason } })
  });
}

function approvalTimeoutError(): McpOperationError {
  return createMcpOperationError({
    code: ErrorCodes.APPROVAL_TIMEOUT,
    message: ErrorCodes.APPROVAL_TIMEOUT,
    finalState: "timed_out",
    retriable: false,
    sideEffects: "none",
    details: { reason: "timeout" }
  });
}

function intentMismatchError(): McpOperationError {
  return createMcpOperationError({
    code: ErrorCodes.APPROVAL_INTENT_MISMATCH,
    message: ErrorCodes.APPROVAL_INTENT_MISMATCH,
    finalState: "failed",
    retriable: false,
    sideEffects: "none"
  });
}

function executionFailureError(): McpOperationError {
  return createMcpOperationError({
    code: ErrorCodes.STATE_UNKNOWN,
    message: ErrorCodes.STATE_UNKNOWN,
    finalState: "unknown",
    retriable: false,
    sideEffects: "possible",
    details: { reason: "execution_failed" }
  });
}

function resourceLimitResult(): ApprovalExecution<never> {
  return {
    approved: false,
    error: createMcpOperationError({
      code: ErrorCodes.RESOURCE_LIMIT,
      message: ErrorCodes.RESOURCE_LIMIT,
      finalState: "failed",
      retriable: false,
      sideEffects: "none"
    })
  };
}

function disconnectedResult(): ApprovalExecution<never> {
  return { approved: false, error: approvalDeclinedError("disconnected") };
}

function intentMismatchResult(): ApprovalExecution<never> {
  return { approved: false, error: intentMismatchError() };
}
