import type { HostConfig } from "../config/schema.js";
import { ErrorCodes, createMcpOperationError, type ErrorCode, type McpOperationError } from "../errors/error-contract.js";
import {
  OperationManager,
  OperationManagerError,
  type OperationGetResult,
  type OperationRunner,
  type OperationSnapshot,
  type OperationTimeoutKind
} from "../operations/operation-manager.js";
import { DEFAULT_OUTPUT_READ_BYTES } from "../operations/output-buffer.js";
import { isTerminalOperationState, type OperationState } from "../operations/state-machine.js";

export type MultiHostExecutionMode = "parallel" | "sequential";
export type HostOperationState = "not_started" | "running" | "completed" | "failed" | "timed_out" | "cancelled" | "unknown";

export interface MultiHostChildResult extends Readonly<Record<string, unknown>> {
  readonly host: string;
  readonly state: HostOperationState;
  readonly operationId?: string;
  readonly result?: Readonly<Record<string, unknown>>;
  readonly error?: McpOperationError;
  readonly output?: Readonly<{ truncated: boolean; droppedBytes: number }>;
}

export interface MultiHostResult extends Readonly<Record<string, unknown>> {
  readonly executionMode: MultiHostExecutionMode;
  readonly hosts: readonly MultiHostChildResult[];
  readonly stopRequested: boolean;
  readonly stopReason?: "cancel" | "timeout";
}

export interface MultiHostStartOptions {
  readonly hosts: readonly HostConfig[];
  readonly executionMode: MultiHostExecutionMode;
  readonly timeoutKind: OperationTimeoutKind;
  readonly failureCode: ErrorCode;
  readonly timeoutCode: ErrorCode;
  /** 每次调用必须创建一个独立的单主机操作，绝不能复用 SSH 连接或 Operation。 */
  start(host: HostConfig): OperationSnapshot;
}

interface ChildRecord {
  readonly host: HostConfig;
  operationId: string | undefined;
  state: HostOperationState;
  result: Readonly<Record<string, unknown>> | undefined;
  error: McpOperationError | undefined;
  outputCursor: number;
  outputTruncated: boolean;
  outputDroppedBytes: number;
  outputFinished: boolean;
}

/**
 * 把既有的单主机运行器汇合为一个父 Operation。它不创建连接、不重试也不回滚，
 * 只按请求顺序调度独立子操作并聚合它们已确认的终态。
 */
export class MultiHostCoordinator {
  public constructor(private readonly manager: OperationManager) {}

  public start(options: MultiHostStartOptions): OperationSnapshot {
    assertHosts(options.hosts);
    return new MultiHostExecution(this.manager, options).start();
  }
}

class MultiHostExecution implements OperationRunner {
  private operationId = "";
  private stopping = false;
  private stopReason: "cancel" | "timeout" | undefined;
  private readonly children: ChildRecord[];

  public constructor(private readonly manager: OperationManager, private readonly options: MultiHostStartOptions) {
    this.children = options.hosts.map((host) => ({
      host, operationId: undefined, state: "not_started", result: undefined, error: undefined,
      outputCursor: 0, outputTruncated: false, outputDroppedBytes: 0, outputFinished: false
    }));
  }

  public start(): OperationSnapshot {
    const snapshot = this.manager.createWithoutBusinessTimeout({
      initialState: "running", runner: this, timeoutKind: this.options.timeoutKind,
      // 父操作不得以独立业务计时器抢占已启动子项的超时与停止确认窗口。
    });
    this.operationId = snapshot.operationId;
    this.publish();
    queueMicrotask(() => { void this.run().catch((error: unknown) => this.backgroundFailure(error)); });
    return snapshot;
  }

  public cancel(reason: "cancel" | "timeout"): void {
    if (this.stopping) return;
    this.stopping = true;
    this.stopReason = reason;
    for (const child of this.children) {
      if (child.operationId === undefined) {
        child.state = "cancelled";
        continue;
      }
      if (!isTerminalHostState(child.state)) {
        try { this.manager.cancel(child.operationId); } catch { child.state = "unknown"; }
      }
    }
    this.refreshStartedChildren();
    this.publish();
  }

  public forceStop(): MultiHostResult {
    this.cancel(this.stopReason ?? "cancel");
    return this.result();
  }

  private async run(): Promise<void> {
    if (this.options.executionMode === "parallel") {
      for (const child of this.children) {
        if (this.stopping) break;
        this.startChild(child);
      }
      await Promise.all(this.children.filter((child) => child.operationId !== undefined).map(async (child) => await this.waitForTerminal(child)));
    } else {
      for (const child of this.children) {
        if (this.stopping) break;
        this.startChild(child);
        await this.waitForTerminal(child);
      }
    }
    if (this.stopping) {
      for (const child of this.children) if (child.state === "not_started") child.state = "cancelled";
    }
    this.refreshStartedChildren();
    this.publish();
    this.finish();
  }

  private startChild(child: ChildRecord): void {
    try {
      const snapshot = this.options.start(child.host);
      child.operationId = snapshot.operationId;
      this.applySnapshot(child, snapshot);
    } catch (error: unknown) {
      child.state = "failed";
      child.error = childError(error, this.operationId, child.host.alias);
    }
    this.publish();
  }

  private async waitForTerminal(child: ChildRecord): Promise<void> {
    if (child.operationId === undefined) return;
    while (true) {
      const hasImmediatelyReadableOutput = this.refreshChild(child);
      this.publish();
      if (isTerminalHostState(child.state)) return;
      // 达到单轮转发配额时，变化通知可能已在监听前发出。此处先让出微任务，
      // 再继续用 cursor 主动排空，避免把已有输出错误地当作“等待下一次变化”。
      if (hasImmediatelyReadableOutput) {
        await Promise.resolve();
        continue;
      }
      await this.manager.waitForChange(child.operationId);
    }
  }

  private refreshStartedChildren(): void {
    for (const child of this.children) this.refreshChild(child);
  }

  private refreshChild(child: ChildRecord): boolean {
    if (child.operationId === undefined || child.outputFinished) return false;
    try {
      return this.drainChildOutput(child);
    } catch (error: unknown) {
      child.state = "unknown";
      child.error = childError(error, this.operationId, child.host.alias);
      return false;
    }
  }

  private applySnapshot(child: ChildRecord, snapshot: OperationSnapshot): void {
    child.state = hostState(snapshot.state);
    child.result = snapshot.result;
    child.error = snapshot.error;
  }

  /**
   * 每个子项独立 cursor 严格前移一次；父缓冲保存原始字节和经绑定的登记 alias，
   * 子项过保留期后仍可通过父 operation_get 查询输出。
   */
  private drainChildOutput(child: ChildRecord): boolean {
    let reads = 0;
    while (true) {
      const snapshot = this.manager.get(child.operationId!, child.outputCursor, DEFAULT_OUTPUT_READ_BYTES);
      this.applySnapshot(child, snapshot);
      child.outputTruncated ||= snapshot.truncated;
      child.outputDroppedBytes = Math.max(child.outputDroppedBytes, snapshot.droppedBytes);
      const previousCursor = child.outputCursor;
      for (const frame of snapshot.frames) {
        this.manager.appendOutput(this.operationId, frame.stream, frameBytes(frame), { host: child.host.alias });
      }
      child.outputCursor = snapshot.nextCursor;
      reads += 1;
      if (snapshot.nextCursor === previousCursor || snapshot.frames.length === 0) {
        if (isTerminalHostState(child.state)) child.outputFinished = true;
        return false;
      }
      // 运行中的持续输出每轮最多转发 256 KiB；终态缓冲有限，必须一次排空。
      // 配额耗尽后用同一 cursor 再做一次只读探测：只有 nextCursor 仍可推进，
      // 才说明已有未消费输出，下一轮不能等待一个已错过的变化通知。
      if (!isTerminalHostState(child.state) && reads >= 4) {
        const unread = this.manager.get(child.operationId!, child.outputCursor, DEFAULT_OUTPUT_READ_BYTES);
        return unread.nextCursor !== child.outputCursor && unread.frames.length > 0;
      }
    }
  }

  private finish(): void {
    const aggregate = aggregateState(this.children.map((child) => child.state));
    const result = this.result();
    switch (aggregate) {
      case "completed":
        this.manager.complete(this.operationId, result);
        return;
      case "failed":
        this.manager.fail(this.operationId, aggregateError(this.options.failureCode, "failed", this.operationId), result);
        return;
      case "timed_out":
        this.manager.timedOut(this.operationId, aggregateError(this.options.timeoutCode, "timed_out", this.operationId), result);
        return;
      case "cancelled":
        if (this.stopping) {
          this.manager.confirmStopped(this.operationId, result, this.stopReason === "timeout"
            ? aggregateError(this.options.timeoutCode, "timed_out", this.operationId)
            : undefined);
        } else {
          this.manager.unknown(this.operationId, aggregateError(ErrorCodes.STATE_UNKNOWN, "unknown", this.operationId), result);
        }
        return;
      case "partial_failure":
        this.manager.partialFailure(this.operationId, aggregateError(ErrorCodes.PARTIAL_FAILURE, "partial_failure", this.operationId), result);
        return;
      case "unknown":
        this.manager.unknown(this.operationId, aggregateError(ErrorCodes.STATE_UNKNOWN, "unknown", this.operationId), result);
        return;
    }
  }

  private publish(): void {
    try { this.manager.updateResult(this.operationId, this.result()); }
    catch (error: unknown) {
      if (!(error instanceof OperationManagerError) || (error.code !== ErrorCodes.OPERATION_EXPIRED && error.code !== ErrorCodes.OPERATION_NOT_FOUND)) throw error;
    }
  }

  private result(): MultiHostResult {
    return Object.freeze({
      executionMode: this.options.executionMode,
      hosts: Object.freeze(this.children.map((child) => Object.freeze({
        host: child.host.alias,
        state: child.state,
        ...(child.operationId === undefined ? {} : { operationId: child.operationId }),
        ...(child.result === undefined ? {} : { result: child.result }),
        ...(child.error === undefined ? {} : { error: child.error }),
        ...(child.outputTruncated || child.outputDroppedBytes > 0
          ? { output: Object.freeze({ truncated: child.outputTruncated, droppedBytes: child.outputDroppedBytes }) }
          : {})
      }))),
      stopRequested: this.stopping,
      ...(this.stopReason === undefined ? {} : { stopReason: this.stopReason })
    });
  }

  private backgroundFailure(error: unknown): void {
    try {
      this.manager.unknown(this.operationId, aggregateError(ErrorCodes.STATE_UNKNOWN, "unknown", this.operationId), this.result());
    } catch {
      // 后台 detached 边界不得产生未处理拒绝。
    }
    void error;
  }
}

function frameBytes(frame: OperationGetResult["frames"][number]): Buffer {
  return frame.encoding === "base64" ? Buffer.from(frame.data, "base64") : Buffer.from(frame.data, "utf8");
}

function assertHosts(hosts: readonly HostConfig[]): void {
  if (hosts.length < 1 || hosts.length > 10 || new Set(hosts.map((host) => host.alias)).size !== hosts.length) {
    throw new TypeError("多主机集合必须包含 1–10 个唯一登记别名");
  }
}

function hostState(state: OperationState): HostOperationState {
  switch (state) {
    case "awaiting_approval":
    case "running": return "running";
    case "completed": return "completed";
    case "failed":
    case "partial_failure": return "failed";
    case "timed_out": return "timed_out";
    case "cancelled": return "cancelled";
    case "unknown": return "unknown";
  }
}

function isTerminalHostState(state: HostOperationState): boolean {
  return state !== "not_started" && state !== "running";
}

function aggregateState(states: readonly HostOperationState[]): "completed" | "failed" | "timed_out" | "cancelled" | "partial_failure" | "unknown" {
  if (states.some((state) => state === "unknown" || state === "not_started" || state === "running")) return "unknown";
  if (states.every((state) => state === "completed")) return "completed";
  if (states.every((state) => state === "cancelled")) return "cancelled";
  if (states.every((state) => state === "failed")) return "failed";
  if (states.every((state) => state === "timed_out")) return "timed_out";
  return "partial_failure";
}

function aggregateError(code: McpOperationError["code"], finalState: McpOperationError["finalState"], operationId: string): McpOperationError {
  return createMcpOperationError({ code, message: code, finalState, retriable: false, sideEffects: "partial", operationId }, undefined, {
    allowedOperationIds: new Set([operationId])
  });
}

function childError(error: unknown, operationId: string, host: string): McpOperationError {
  if (error instanceof OperationManagerError) return error.error;
  return createMcpOperationError({
    code: ErrorCodes.INTERNAL_ERROR, message: ErrorCodes.INTERNAL_ERROR, finalState: "failed", retriable: false,
    sideEffects: "none", operationId, host
  }, undefined, { allowedOperationIds: new Set([operationId]), allowedHosts: new Set([host]) });
}
