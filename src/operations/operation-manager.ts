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
}

export interface OperationManagerOptions {
  readonly clock?: MonotonicClock;
  readonly idFactory?: () => string;
  readonly limits?: Partial<OperationLimits>;
  readonly outputBufferBytes?: number;
}

export interface OperationSnapshot {
  readonly operationId: string;
  readonly state: OperationState;
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
  runner: OperationRunner | undefined;
  cancelReason: "cancel" | "timeout" | undefined;
  timeoutKind: OperationTimeoutKind | undefined;
  error: McpOperationError | undefined;
  result: Readonly<Record<string, unknown>> | undefined;
  timeoutTimer: unknown;
  cancellationTimer: unknown;
  retentionTimer: unknown;
}

/** 生命周期存储只负责协调运行器，不会自行启动、重试或重放任何远程操作。 */
export class OperationManager {
  private readonly records = new Map<string, OperationRecord>();
  private readonly expiredIds = new Set<string>();
  private readonly limits: OperationLimits;
  private readonly clock: MonotonicClock;
  private readonly idFactory: () => string;
  private readonly outputBufferBytes: number;

  public constructor(options: OperationManagerOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.idFactory = options.idFactory ?? randomUUID;
    this.limits = { ...DEFAULT_OPERATION_LIMITS, ...options.limits };
    this.outputBufferBytes = options.outputBufferBytes ?? DEFAULT_OUTPUT_BUFFER_BYTES;
    for (const value of Object.values(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError("操作时间预算必须是正安全整数");
      }
    }
  }

  public create(options: CreateOperationOptions = {}): OperationSnapshot {
    if (this.activeCount() >= 32) {
      throw this.error(ErrorCodes.RESOURCE_LIMIT, "failed", false, "none");
    }
    const id = this.idFactory();
    if (id.length === 0 || this.records.has(id) || this.expiredIds.has(id)) {
      throw new Error("操作 ID 必须唯一且非空");
    }
    const initialState = options.initialState ?? "awaiting_approval";
    const timeoutKind = options.timeoutKind ?? "command";
    this.assertTimeoutKind(timeoutKind);
    const timeoutMs = initialState === "running"
      ? this.resolveOperationTimeout(options.timeoutMs, timeoutKind)
      : undefined;
    const record: OperationRecord = {
      id,
      machine: new OperationStateMachine(initialState),
      output: new OutputBuffer(this.outputBufferBytes),
      runner: options.runner,
      cancelReason: undefined,
      timeoutKind,
      error: undefined,
      result: undefined,
      timeoutTimer: undefined,
      cancellationTimer: undefined,
      retentionTimer: undefined
    };
    this.records.set(id, record);
    if (initialState === "running") {
      this.scheduleOperationTimeout(record, timeoutMs!, timeoutKind);
    } else {
      this.scheduleApprovalTimeout(record);
    }
    return this.snapshot(record);
  }

  public start(
    id: string,
    runner?: OperationRunner,
    timeoutMs?: number,
    timeoutKind?: OperationTimeoutKind
  ): OperationSnapshot {
    const record = this.record(id);
    const effectiveTimeoutKind = timeoutKind ?? record.timeoutKind ?? "command";
    const effectiveTimeoutMs = this.resolveOperationTimeout(timeoutMs, effectiveTimeoutKind);
    record.machine.transition("running");
    record.runner = runner;
    this.scheduleOperationTimeout(record, effectiveTimeoutMs, effectiveTimeoutKind);
    return this.snapshot(record);
  }

  public complete(id: string, result?: Readonly<Record<string, unknown>>): OperationSnapshot { return this.finish(id, "completed", undefined, result); }
  public fail(id: string, error?: McpOperationError, result?: Readonly<Record<string, unknown>>): OperationSnapshot { return this.finish(id, "failed", error, result); }
  public partialFailure(id: string, error?: McpOperationError, result?: Readonly<Record<string, unknown>>): OperationSnapshot { return this.finish(id, "partial_failure", error, result); }
  public unknown(id: string, error?: McpOperationError, result?: Readonly<Record<string, unknown>>): OperationSnapshot { return this.finish(id, "unknown", error, result); }

  public appendOutput(id: string, stream: OutputStream, data: Buffer): void {
    const record = this.record(id);
    if (record.machine.state === "running") {
      record.output.append(stream, data);
    }
  }

  /** 长操作可在运行期间发布结构化进度；不会改变状态或输出游标。 */
  public updateResult(id: string, result: Readonly<Record<string, unknown>>): OperationSnapshot {
    const record = this.record(id);
    if (record.machine.state === "running") {
      record.result = Object.freeze({ ...result });
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
    record.machine.transition(state);
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
  }

  private clearTimer(timer: unknown): void {
    if (timer !== undefined) this.clock.clearTimeout(timer);
  }

  private snapshot(record: OperationRecord): OperationSnapshot {
    return Object.freeze({ operationId: record.id, state: record.machine.state, ...(record.result === undefined ? {} : { result: record.result }), ...(record.error === undefined ? {} : { error: record.error }) });
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

const systemClock: MonotonicClock = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout)
};
