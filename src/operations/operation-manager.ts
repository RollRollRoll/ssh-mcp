import { randomUUID } from "node:crypto";
import {
  ErrorCodes,
  createMcpOperationError,
  type McpOperationError
} from "../errors/error-contract.js";
import {
  DEFAULT_OUTPUT_BUFFER_BYTES,
  DEFAULT_OUTPUT_READ_BYTES,
  MAX_OUTPUT_READ_BYTES,
  OutputBuffer,
  OutputBufferError,
  type OutputReadResult,
  type OutputStream
} from "./output-buffer.js";
import {
  OperationStateMachine,
  isTerminalOperationState,
  type OperationState
} from "./state-machine.js";

export interface MonotonicClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

export interface OperationRunner {
  cancel(reason: "cancel" | "timeout"): void | Promise<void>;
  /**
   * 强制断开前同步冻结运行器已知结果；管理器在同一终态提交中持久化该快照。
   * 不支持异步返回，避免强制关闭后的迟到事件在结果写入前抢占终态。
   */
  forceStop?(): Readonly<Record<string, unknown>> | undefined;
}

export type OperationTimeoutKind = "connect" | "command" | "session" | "transfer" | "approval";

const operationTimeoutKinds = new Set<OperationTimeoutKind>([
  "connect", "command", "session", "transfer", "approval"
]);
const MAX_ACTIVE_OPERATIONS = 32;
const MAX_OPERATION_RECORDS = 64;
const MAX_EXPIRED_OPERATION_IDS = 64;
export const MAX_OUTPUT_TRUNCATION_EVENTS_PER_OPERATION = 4;

export interface OperationLimits {
  readonly connectTimeoutMs: number;
  readonly commandTimeoutMs: number;
  readonly sessionIdleTimeoutMs: number;
  readonly transferTimeoutMs: number;
  readonly approvalTimeoutMs: number;
  readonly cancelConfirmationTimeoutMs: number;
  readonly resultRetentionMs: number;
}

export const DEFAULT_OPERATION_LIMITS: OperationLimits = Object.freeze({
  connectTimeoutMs: 15_000,
  commandTimeoutMs: 300_000,
  sessionIdleTimeoutMs: 1_800_000,
  transferTimeoutMs: 1_800_000,
  approvalTimeoutMs: 120_000,
  cancelConfirmationTimeoutMs: 10_000,
  resultRetentionMs: 900_000
});

export interface CreateOperationOptions {
  readonly initialState?: "awaiting_approval" | "running";
  readonly runner?: OperationRunner;
  readonly timeoutKind?: OperationTimeoutKind;
  readonly timeoutMs?: number;
  /** ApprovalService 自行持有 Elicitation 截止时间时，禁止登记第二个竞争计时器。 */
  readonly approvalTimeoutManagedExternally?: boolean;
  readonly target?: OperationTargetSummary;
}

export interface OperationTargetSummary {
  readonly hosts: readonly string[];
}

export interface OutputTruncatedEvent {
  readonly operationId: string;
  readonly host?: string;
  readonly droppedBytes: number;
  readonly minCursor: number;
}

export interface OperationManagerOptions {
  readonly clock?: MonotonicClock;
  readonly idFactory?: () => string;
  readonly limits?: Partial<OperationLimits>;
  readonly outputBufferBytes?: number;
  readonly onStateChange?: (snapshot: OperationSnapshot) => void;
  readonly onOutputTruncated?: (event: OutputTruncatedEvent) => void;
}

export interface OperationSnapshot {
  readonly operationId: string;
  readonly state: OperationState;
  readonly host?: string;
  readonly target?: OperationTargetSummary;
  readonly lastStateChangeAt: number;
  readonly result?: Readonly<Record<string, unknown>>;
  readonly error?: McpOperationError;
}

export interface OperationGetResult extends OperationSnapshot, OutputReadResult {}

export class OperationManagerError extends Error {
  public constructor(readonly error: McpOperationError) {
    super(error.message);
    this.name = "OperationManagerError";
  }

  public get code(): McpOperationError["code"] {
    return this.error.code;
  }
}

interface OperationRecord {
  readonly id: string;
  readonly machine: OperationStateMachine;
  readonly output: OutputBuffer;
  readonly target: OperationTargetSummary | undefined;
  lastStateChangeAt: number;
  runner: OperationRunner | undefined;
  cancelReason: "cancel" | "timeout" | undefined;
  timeoutKind: OperationTimeoutKind | undefined;
  error: McpOperationError | undefined;
  result: Readonly<Record<string, unknown>> | undefined;
  timeoutTimer: unknown;
  cancellationTimer: unknown;
  retentionTimer: unknown;
  outputTruncation: OutputTruncationSummary | undefined;
  readonly changeListeners: Set<() => void>;
}

interface OutputTruncationSummary {
  pendingDroppedBytes: number;
  totalDroppedBytes: number;
  minCursor: number;
  emittedEvents: number;
  nextPeriodicAt: number;
}

/** 生命周期存储只负责协调运行器，不会自行启动、重试或重放任何远程操作。 */
export class OperationManager {
  private readonly records = new Map<string, OperationRecord>();
  private readonly expiredIds = new Set<string>();
  private readonly limits: OperationLimits;
  private readonly clock: MonotonicClock;
  private readonly idFactory: () => string;
  private readonly outputBufferBytes: number;
  private readonly onStateChange: ((snapshot: OperationSnapshot) => void) | undefined;
  private readonly onOutputTruncated: ((event: OutputTruncatedEvent) => void) | undefined;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | undefined;

  public constructor(options: OperationManagerOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.idFactory = options.idFactory ?? randomUUID;
    this.limits = { ...DEFAULT_OPERATION_LIMITS, ...options.limits };
    this.outputBufferBytes = options.outputBufferBytes ?? DEFAULT_OUTPUT_BUFFER_BYTES;
    this.onStateChange = options.onStateChange;
    this.onOutputTruncated = options.onOutputTruncated;
    for (const value of Object.values(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError("操作时间预算必须是正安全整数");
      }
    }
  }

  public create(options: CreateOperationOptions = {}): OperationSnapshot {
    return this.createRecord(options, false);
  }

  /**
   * 仅供父级协调器使用：父项没有独立业务截止时间，必须由已启动子项的终态或显式取消收敛。
   * 普通 create/start 的超时契约不受影响。
   */
  public createWithoutBusinessTimeout(options: Omit<CreateOperationOptions, "timeoutMs"> = {}): OperationSnapshot {
    return this.createRecord(options, true);
  }

  private createRecord(options: CreateOperationOptions, withoutBusinessTimeout: boolean): OperationSnapshot {
    if (this.shuttingDown || this.activeCount() >= MAX_ACTIVE_OPERATIONS || this.records.size >= MAX_OPERATION_RECORDS) {
      throw this.error(ErrorCodes.RESOURCE_LIMIT, "failed", false, "none");
    }
    const id = this.idFactory();
    if (id.length === 0 || this.records.has(id) || this.expiredIds.has(id)) {
      throw new Error("操作 ID 必须唯一且非空");
    }
    const initialState = options.initialState ?? "awaiting_approval";
    const timeoutKind = options.timeoutKind ?? "command";
    this.assertTimeoutKind(timeoutKind);
    const timeoutMs = initialState === "running" && !withoutBusinessTimeout
      ? this.resolveOperationTimeout(options.timeoutMs, timeoutKind)
      : undefined;
    const record: OperationRecord = {
      id,
      machine: new OperationStateMachine(initialState),
      output: new OutputBuffer(this.outputBufferBytes),
      target: freezeTarget(options.target),
      lastStateChangeAt: this.clock.now(),
      runner: options.runner,
      cancelReason: undefined,
      timeoutKind,
      error: undefined,
      result: undefined,
      timeoutTimer: undefined,
      cancellationTimer: undefined,
      retentionTimer: undefined,
      outputTruncation: undefined,
      changeListeners: new Set()
    };
    this.records.set(id, record);
    if (initialState === "running") {
      if (timeoutMs !== undefined) this.scheduleOperationTimeout(record, timeoutMs, timeoutKind);
    } else if (options.approvalTimeoutManagedExternally !== true) {
      this.scheduleApprovalTimeout(record);
    }
    const snapshot = this.snapshot(record);
    this.onStateChange?.(snapshot);
    return snapshot;
  }

  /** 供父操作按已登记子操作数量计算总预算；不暴露或修改具体限制值。 */
  public timeoutForKind(kind: OperationTimeoutKind): number {
    return this.timeoutFor(kind);
  }

  /** 父协调器必须把子操作的停止确认窗口纳入自身生命周期预算。 */
  public cancelConfirmationTimeout(): number {
    return this.limits.cancelConfirmationTimeoutMs;
  }

  public start(
    id: string,
    runner?: OperationRunner,
    timeoutMs?: number,
    timeoutKind?: OperationTimeoutKind
  ): OperationSnapshot {
    if (this.shuttingDown) throw this.error(ErrorCodes.RESOURCE_LIMIT, "failed", false, "none", id);
    const record = this.record(id);
    const effectiveTimeoutKind = timeoutKind ?? record.timeoutKind ?? "command";
    const effectiveTimeoutMs = this.resolveOperationTimeout(timeoutMs, effectiveTimeoutKind);
    record.machine.transition("running");
    this.markStateChange(record);
    record.runner = runner;
    this.scheduleOperationTimeout(record, effectiveTimeoutMs, effectiveTimeoutKind);
    const snapshot = this.snapshot(record);
    this.onStateChange?.(snapshot);
    return snapshot;
  }

  /** 审批通过后，后台运行器接管同一条已经进入 running 的 Operation。 */
  public attachRunner(
    id: string,
    runner: OperationRunner,
    timeoutKind: OperationTimeoutKind,
    withoutBusinessTimeout = false
  ): OperationSnapshot {
    if (this.shuttingDown) throw this.error(ErrorCodes.RESOURCE_LIMIT, "failed", false, "none", id);
    const record = this.record(id);
    if (record.machine.state !== "running" || record.runner !== undefined) {
      throw new Error("只有未被接管的 running 操作可以绑定运行器");
    }
    this.clearTimer(record.timeoutTimer);
    record.timeoutTimer = undefined;
    record.runner = runner;
    record.timeoutKind = timeoutKind;
    if (!withoutBusinessTimeout) {
      this.scheduleOperationTimeout(record, this.timeoutFor(timeoutKind), timeoutKind);
    }
    const snapshot = this.snapshot(record);
    this.onStateChange?.(snapshot);
    return snapshot;
  }

  /** 幂等停止：先请求正常停止，固定截止时间后把无法确认的运行项保守收敛为 unknown。 */
  public shutdown(timeoutMs = this.limits.cancelConfirmationTimeoutMs): Promise<void> {
    if (this.shutdownPromise !== undefined) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = new Promise((resolve) => {
      let deadlineTimer: unknown;
      const finishIfDone = (): void => {
        if (this.activeCount() !== 0) return;
        this.clearTimer(deadlineTimer);
        resolve();
      };
      for (const record of this.records.values()) {
        if (record.machine.state === "awaiting_approval") {
          this.finishRecord(record, "failed", this.operationError(
            ErrorCodes.APPROVAL_DECLINED, "failed", false, "none", record.id, { reason: "disconnected" }
          ));
        } else if (!isTerminalOperationState(record.machine.state)) {
          record.changeListeners.add(finishIfDone);
          this.requestStop(record, "cancel");
        }
      }
      finishIfDone();
      if (this.activeCount() === 0) return;
      deadlineTimer = this.clock.setTimeout(() => {
        for (const record of this.records.values()) {
          if (isTerminalOperationState(record.machine.state)) continue;
          let result: Readonly<Record<string, unknown>> | undefined;
          try { result = record.runner?.forceStop?.(); } catch { /* 截止时间后的强制关闭只做尽力清理。 */ }
          this.finishRecord(record, "unknown", this.operationError(
            ErrorCodes.CANCEL_UNCONFIRMED, "unknown", false, "possible", record.id, { reason: "cancel" }
          ), result);
        }
        resolve();
      }, timeoutMs);
    });
    return this.shutdownPromise;
  }

  public complete(id: string, result?: Readonly<Record<string, unknown>>): OperationSnapshot { return this.finish(id, "completed", undefined, result); }
  public fail(id: string, error?: McpOperationError, result?: Readonly<Record<string, unknown>>): OperationSnapshot { return this.finish(id, "failed", error, result); }
  public timedOut(id: string, error?: McpOperationError, result?: Readonly<Record<string, unknown>>): OperationSnapshot { return this.finishRecord(this.record(id), "timed_out", error, result); }
  public partialFailure(id: string, error?: McpOperationError, result?: Readonly<Record<string, unknown>>): OperationSnapshot { return this.finish(id, "partial_failure", error, result); }
  public unknown(id: string, error?: McpOperationError, result?: Readonly<Record<string, unknown>>): OperationSnapshot { return this.finish(id, "unknown", error, result); }

  public appendOutput(id: string, stream: OutputStream, data: Buffer, metadata?: Readonly<{ host?: string }>): void {
    const record = this.record(id);
    if (record.machine.state === "running") {
      const appended = record.output.append(stream, data, metadata);
      if (appended !== undefined && appended.droppedBytes > 0) {
        this.recordOutputTruncation(record, appended.droppedBytes, appended.minCursor);
      }
      this.notifyChanged(record);
    }
  }

  /** 长操作可在运行期间发布结构化进度；不会改变状态或输出游标。 */
  public updateResult(id: string, result: Readonly<Record<string, unknown>>): OperationSnapshot {
    const record = this.record(id);
    if (record.machine.state === "running") {
      record.result = Object.freeze({ ...result });
      this.notifyChanged(record);
    }
    return this.snapshot(record);
  }

  public get(id: string, cursor = 0, maxBytes = DEFAULT_OUTPUT_READ_BYTES): OperationGetResult {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_OUTPUT_READ_BYTES) {
      throw this.error(ErrorCodes.INVALID_ARGUMENT, "failed", false, "none", id);
    }
    const record = this.record(id);
    try {
      return Object.freeze({ ...this.snapshot(record), ...record.output.read(cursor, maxBytes) });
    } catch (error: unknown) {
      if (error instanceof OutputBufferError) {
        throw this.error(ErrorCodes.INVALID_CURSOR, "failed", false, "none", id);
      }
      throw error;
    }
  }

  /** 等待运行中操作产生输出、进度或生命周期变化；终态立即返回。 */
  public waitForChange(id: string): Promise<void> {
    const record = this.record(id);
    if (isTerminalOperationState(record.machine.state)) return Promise.resolve();
    return new Promise((resolve) => {
      const listener = (): void => {
        record.changeListeners.delete(listener);
        resolve();
      };
      record.changeListeners.add(listener);
    });
  }

  public cancel(id: string): OperationSnapshot {
    const record = this.record(id);
    if (isTerminalOperationState(record.machine.state)) {
      return this.snapshot(record);
    }
    if (record.machine.state === "awaiting_approval") {
      return this.finishRecord(record, "failed");
    }
    this.requestStop(record, "cancel");
    return this.snapshot(record);
  }

  /** 仅由运行器在远端 Channel/流真正停止后调用。 */
  public confirmStopped(
    id: string,
    result?: Readonly<Record<string, unknown>>,
    error?: McpOperationError
  ): OperationSnapshot {
    const record = this.record(id);
    if (isTerminalOperationState(record.machine.state)) {
      return this.snapshot(record);
    }
    if (record.cancelReason === undefined) {
      throw new Error("操作未处于等待停止确认状态");
    }
    return this.finishRecord(
      record,
      record.cancelReason === "timeout" ? "timed_out" : "cancelled",
      error,
      result
    );
  }

  private finish(id: string, state: "completed" | "failed" | "partial_failure" | "unknown", error?: McpOperationError, result?: Readonly<Record<string, unknown>>): OperationSnapshot {
    return this.finishRecord(this.record(id), state, error, result);
  }

  private finishRecord(record: OperationRecord, state: OperationState, error?: McpOperationError, result?: Readonly<Record<string, unknown>>): OperationSnapshot {
    if (isTerminalOperationState(record.machine.state)) {
      return this.snapshot(record);
    }
    this.flushOutputTruncation(record, true);
    record.machine.transition(state);
    this.markStateChange(record);
    const cancelReason = record.cancelReason;
    this.clearTimer(record.timeoutTimer);
    this.clearTimer(record.cancellationTimer);
    record.timeoutTimer = undefined;
    record.cancellationTimer = undefined;
    record.runner = undefined;
    record.cancelReason = undefined;
    if (result !== undefined) {
      record.result = Object.freeze({ ...result });
    }
    if (error !== undefined) {
      record.error = error;
    } else if (state === "unknown") {
      record.error = cancelReason === "timeout"
        ? this.operationError(ErrorCodes.STATE_UNKNOWN, "unknown", false, "possible", record.id, {
          reason: "timeout",
          timeoutKind: record.timeoutKind
        })
        : this.operationError(ErrorCodes.CANCEL_UNCONFIRMED, "unknown", false, "possible", record.id, { reason: "cancel" });
    }
    record.retentionTimer = this.clock.setTimeout(() => this.expire(record.id), this.limits.resultRetentionMs);
    this.notifyChanged(record);
    this.onStateChange?.(this.snapshot(record));
    return this.snapshot(record);
  }

  private requestStop(record: OperationRecord, reason: "cancel" | "timeout"): void {
    if (isTerminalOperationState(record.machine.state) || record.cancelReason !== undefined) {
      return;
    }
    record.cancelReason = reason;
    this.clearTimer(record.timeoutTimer);
    record.timeoutTimer = undefined;
    if (record.runner === undefined) {
      this.finishRecord(record, reason === "timeout" ? "timed_out" : "cancelled");
      return;
    }
    const runner = record.runner;
    try {
      void Promise.resolve(runner.cancel(reason)).catch(() => undefined);
    } catch {
      // 取消调用失败不能证明远端已停止，仍等待确认窗口结束。
    }
    if (isTerminalOperationState(record.machine.state) || record.cancelReason === undefined) {
      return;
    }
    record.cancellationTimer = this.clock.setTimeout(() => {
      if (!isTerminalOperationState(record.machine.state) && record.cancelReason !== undefined) {
        let result: Readonly<Record<string, unknown>> | undefined;
        try {
          result = record.runner?.forceStop?.();
        } catch {
          // 强制关闭是尽力而为；无法证明远端停止，仍须收敛为 unknown。
        }
        this.finishRecord(record, "unknown", undefined, result);
      }
    }, this.limits.cancelConfirmationTimeoutMs);
  }

  private scheduleApprovalTimeout(record: OperationRecord): void {
    record.timeoutTimer = this.clock.setTimeout(() => {
      if (record.machine.state === "awaiting_approval") {
        this.finishRecord(record, "failed", this.operationError(
          ErrorCodes.APPROVAL_TIMEOUT,
          "failed",
          false,
          "none",
          record.id
        ));
      }
    }, this.limits.approvalTimeoutMs);
  }

  private scheduleOperationTimeout(record: OperationRecord, timeoutMs: number, timeoutKind: OperationTimeoutKind): void {
    this.assertTimeoutKind(timeoutKind);
    this.assertTimeoutMs(timeoutMs);
    this.clearTimer(record.timeoutTimer);
    record.timeoutKind = timeoutKind;
    record.timeoutTimer = this.clock.setTimeout(() => {
      if (record.machine.state === "running") {
        this.requestStop(record, "timeout");
      }
    }, timeoutMs);
  }

  private timeoutFor(kind: OperationTimeoutKind): number {
    this.assertTimeoutKind(kind);
    switch (kind) {
      case "connect": return this.limits.connectTimeoutMs;
      case "command": return this.limits.commandTimeoutMs;
      case "session": return this.limits.sessionIdleTimeoutMs;
      case "transfer": return this.limits.transferTimeoutMs;
      case "approval": return this.limits.approvalTimeoutMs;
    }
  }

  private resolveOperationTimeout(timeoutMs: number | undefined, timeoutKind: OperationTimeoutKind): number {
    this.assertTimeoutKind(timeoutKind);
    const effectiveTimeoutMs = timeoutMs ?? this.timeoutFor(timeoutKind);
    this.assertTimeoutMs(effectiveTimeoutMs);
    return effectiveTimeoutMs;
  }

  private assertTimeoutKind(timeoutKind: OperationTimeoutKind): void {
    if (!operationTimeoutKinds.has(timeoutKind)) {
      throw new RangeError("操作超时类别必须有效");
    }
  }

  private assertTimeoutMs(timeoutMs: number): void {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("操作超时必须是正安全整数");
    }
  }

  private record(id: string): OperationRecord {
    const record = this.records.get(id);
    if (record !== undefined) {
      return record;
    }
    if (this.expiredIds.has(id)) {
      throw this.error(ErrorCodes.OPERATION_EXPIRED, "failed", false, "none", id);
    }
    throw this.error(ErrorCodes.OPERATION_NOT_FOUND, "failed", false, "none", id);
  }

  private activeCount(): number {
    return [...this.records.values()].filter((record) => !isTerminalOperationState(record.machine.state)).length;
  }

  private expire(id: string): void {
    const record = this.records.get(id);
    if (record === undefined || !isTerminalOperationState(record.machine.state)) {
      return;
    }
    this.records.delete(id);
    this.expiredIds.add(id);
    if (this.expiredIds.size > MAX_EXPIRED_OPERATION_IDS) {
      const oldest = this.expiredIds.values().next().value;
      if (oldest !== undefined) this.expiredIds.delete(oldest);
    }
  }

  private notifyChanged(record: OperationRecord): void {
    for (const listener of record.changeListeners) listener();
  }

  private recordOutputTruncation(record: OperationRecord, droppedBytes: number, minCursor: number): void {
    if (this.onOutputTruncated === undefined) return;
    const summary = record.outputTruncation ??= {
      pendingDroppedBytes: 0,
      totalDroppedBytes: 0,
      minCursor,
      emittedEvents: 0,
      nextPeriodicAt: 1
    };
    summary.pendingDroppedBytes += droppedBytes;
    summary.totalDroppedBytes += droppedBytes;
    summary.minCursor = minCursor;
    if (summary.emittedEvents === 0
      || (summary.emittedEvents < MAX_OUTPUT_TRUNCATION_EVENTS_PER_OPERATION - 1
        && summary.totalDroppedBytes >= summary.nextPeriodicAt)) {
      this.flushOutputTruncation(record, false);
    }
  }

  private flushOutputTruncation(record: OperationRecord, terminal: boolean): void {
    const summary = record.outputTruncation;
    if (summary === undefined) return;
    if (summary.pendingDroppedBytes > 0
      && summary.emittedEvents < MAX_OUTPUT_TRUNCATION_EVENTS_PER_OPERATION) {
      this.onOutputTruncated?.({
        operationId: record.id,
        ...(record.target?.hosts.length === 1 ? { host: record.target.hosts[0] } : {}),
        droppedBytes: summary.pendingDroppedBytes,
        minCursor: summary.minCursor
      });
      summary.pendingDroppedBytes = 0;
      summary.emittedEvents += 1;
      summary.nextPeriodicAt = Math.min(Number.MAX_SAFE_INTEGER, Math.max(
        summary.totalDroppedBytes + 1,
        summary.totalDroppedBytes * 2
      ));
    }
    if (terminal) record.outputTruncation = undefined;
  }

  private clearTimer(timer: unknown): void {
    if (timer !== undefined) this.clock.clearTimeout(timer);
  }

  private snapshot(record: OperationRecord): OperationSnapshot {
    return Object.freeze({
      operationId: record.id,
      state: record.machine.state,
      ...(record.target?.hosts.length === 1 ? { host: record.target.hosts[0] } : {}),
      ...(record.target === undefined ? {} : { target: record.target }),
      lastStateChangeAt: record.lastStateChangeAt,
      ...(record.result === undefined ? {} : { result: record.result }),
      ...(record.error === undefined ? {} : { error: record.error })
    });
  }

  private markStateChange(record: OperationRecord): void {
    const now = this.clock.now();
    record.lastStateChangeAt = Number.isFinite(now) ? Math.max(record.lastStateChangeAt, now) : record.lastStateChangeAt;
  }

  private error(
    code: McpOperationError["code"],
    finalState: McpOperationError["finalState"],
    retriable: boolean,
    sideEffects: McpOperationError["sideEffects"],
    operationId?: string
  ): OperationManagerError {
    return new OperationManagerError(this.operationError(code, finalState, retriable, sideEffects, operationId));
  }

  private operationError(
    code: McpOperationError["code"],
    finalState: McpOperationError["finalState"],
    retriable: boolean,
    sideEffects: McpOperationError["sideEffects"],
    operationId?: string,
    details?: Readonly<Record<string, unknown>>
  ): McpOperationError {
    return createMcpOperationError({ code, message: code, finalState, retriable, sideEffects, operationId, details }, undefined, {
      allowedOperationIds: operationId === undefined ? undefined : new Set([operationId])
    });
  }
}

function freezeTarget(target: OperationTargetSummary | undefined): OperationTargetSummary | undefined {
  if (target === undefined) return undefined;
  if (!Array.isArray(target.hosts) || target.hosts.length < 1 || target.hosts.length > 10
    || target.hosts.some((host) => typeof host !== "string" || host.length === 0)
    || new Set(target.hosts).size !== target.hosts.length) {
    throw new RangeError("操作目标主机摘要无效");
  }
  return Object.freeze({ hosts: Object.freeze([...target.hosts]) });
}

const systemClock: MonotonicClock = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout)
};
