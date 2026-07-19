import { Transform, type Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { HostConfig } from "../config/schema.js";
import { createMcpOperationError, type McpOperationError } from "../errors/error-contract.js";
import { ErrorCodes, isErrorCode } from "../errors/error-codes.js";
import type { PathPlatform } from "../paths/path-guard.js";
import {
  OperationManager,
  OperationManagerError,
  type OperationRunner,
  type OperationSnapshot
} from "../operations/operation-manager.js";

export type TransferDirection = "upload" | "download";

export interface SourceFileIdentity {
  readonly kind: "file";
  readonly id: string;
  readonly size: number;
}

/** 仅供目录执行器传递的批准源树元数据，绝不来自 MCP 输入。 */
export interface SourceMountProof {
  readonly sourceRoot: string;
  readonly platform: PathPlatform;
}

export interface TransferRequest {
  readonly direction: TransferDirection;
  readonly host: HostConfig;
  readonly source: string;
  readonly target: string;
  readonly overwrite: boolean;
  /** 旧的直接单文件调用省略时等同 false；MCP 工具层始终显式绑定布尔值。 */
  readonly recursive?: boolean;
  /** 仅供递归目录执行器绑定枚举身份，不来自 MCP 工具输入。 */
  readonly expectedSourceIdentity?: SourceFileIdentity;
  /** 仅供递归目录执行器在真实源句柄打开前后复核挂载证明，不来自 MCP 工具输入。 */
  readonly sourceMountVerifier?: (source: string) => Promise<void>;
  /** 仅供递归目录下载让逐文件 SSH 连接自行建立挂载证明，不来自 MCP 工具输入。 */
  readonly sourceMountProof?: SourceMountProof;
}

export interface PreparedTransfer {
  readonly source: Readable;
  readonly target: Writable;
  readonly totalBytes: number;
  seal(): Promise<void>;
  commit(): Promise<void | "not_needed" | "failed">;
  cleanup(): Promise<boolean>;
  close(): Promise<void>;
}

export interface TransferBackend {
  prepare(request: TransferRequest, signal: AbortSignal): Promise<PreparedTransfer>;
}

export type TemporaryCleanupState = "not_needed" | "removed" | "failed" | "unknown";
export type TransferPhase = "preparing" | "streaming" | "sealing" | "commit_started" | "committed" | "closing" | "terminal";
export type FinalTargetCommitState = "not_committed" | "committed" | "unknown";

export interface PreparedTransferRunHooks {
  isStopping(): boolean;
  onProgress(transferredBytes: number, totalBytes: number): void;
  onPhase(phase: "streaming" | "sealing" | "commit_started" | "committed"): void;
}

export interface PreparedTransferRunResult {
  readonly transferredBytes: number;
  readonly totalBytes: number;
  readonly temporaryCleanup: TemporaryCleanupState;
}

/** Task 10/11 共用的单普通文件流式、字节校验与原子提交核心。 */
export async function runPreparedTransfer(
  prepared: PreparedTransfer,
  hooks: PreparedTransferRunHooks
): Promise<PreparedTransferRunResult> {
  const totalBytes = checkedSize(prepared.totalBytes);
  let transferredBytes = 0;
  hooks.onPhase("streaming");
  hooks.onProgress(transferredBytes, totalBytes);
  if (hooks.isStopping()) throw new Error("传输已停止");
  const meter = new Transform({
    transform: (chunk: Buffer | string, _encoding, callback) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!Number.isSafeInteger(transferredBytes + data.length)) {
        callback(new Error("传输字节数溢出")); return;
      }
      transferredBytes += data.length;
      hooks.onProgress(transferredBytes, totalBytes);
      callback(undefined, data);
    }
  });
  await pipeline(prepared.source, meter, prepared.target);
  if (hooks.isStopping()) throw new Error("传输已停止");
  if (transferredBytes !== totalBytes) throw new Error("源大小与实际流字节不一致");
  hooks.onPhase("sealing");
  await prepared.seal();
  if (hooks.isStopping()) throw new Error("传输已停止");
  hooks.onPhase("commit_started");
  const temporaryCleanup = await prepared.commit() ?? "not_needed";
  hooks.onPhase("committed");
  return Object.freeze({ transferredBytes, totalBytes, temporaryCleanup });
}

/** operation_get 中单文件传输结果的严格字段契约。 */
export interface TransferResult extends Readonly<Record<string, unknown>> {
  readonly direction: TransferDirection;
  readonly host: string;
  readonly source: string;
  readonly target: string;
  readonly transferredBytes: number;
  readonly totalBytes?: number;
  readonly completedItems: 0 | 1;
  readonly temporaryCleanup: TemporaryCleanupState;
  readonly phase: TransferPhase;
  readonly finalTargetCommit: FinalTargetCommitState;
  readonly stopRequested: boolean;
  readonly stopReason?: "cancel" | "timeout";
}

/** prepare 已取得临时目标但尚未交出 PreparedTransfer 时，携带可验证的清理证据。 */
export class TransferPreparationError extends Error {
  public constructor(
    public readonly originalError: unknown,
    public readonly temporaryCleanup: TemporaryCleanupState,
    public readonly resourceCloseFailed = false
  ) {
    super("传输准备失败", { cause: originalError });
    this.name = "TransferPreparationError";
  }
}

/** 单文件传输运行器：不重试、不缓存整文件，只维护真实字节进度。 */
export class TransferService {
  public constructor(private readonly manager: OperationManager, private readonly backend: TransferBackend) {}

  public start(request: TransferRequest): OperationSnapshot {
    const execution = new TransferExecution(this.manager, this.backend, request);
    return execution.start();
  }
}

class TransferExecution implements OperationRunner {
  private operationId = "";
  private prepared: PreparedTransfer | undefined;
  private transferredBytes = 0;
  private totalBytes: number | undefined;
  private stopping = false;
  private stopReason: "cancel" | "timeout" | undefined;
  private cleanupState: TemporaryCleanupState = "not_needed";
  private phase: TransferPhase = "preparing";
  private finalTargetCommit: FinalTargetCommitState = "not_committed";
  private closePromise: Promise<void> | undefined;
  private readonly abortController = new AbortController();

  public constructor(
    private readonly manager: OperationManager,
    private readonly backend: TransferBackend,
    private readonly request: TransferRequest
  ) {}

  public start(): OperationSnapshot {
    const snapshot = this.manager.create({ initialState: "running", runner: this, timeoutKind: "transfer" });
    this.operationId = snapshot.operationId;
    this.publishProgress();
    queueMicrotask(() => {
      void this.run().catch((error: unknown) => this.terminateBackgroundRun(error));
    });
    return snapshot;
  }

  public cancel(reason: "cancel" | "timeout"): void {
    if (this.stopping) return;
    this.stopping = true;
    this.stopReason = reason;
    this.abortController.abort();
    this.destroyStreams();
    this.publishProgress();
  }

  public forceStop(): Readonly<Record<string, unknown>> {
    this.stopping = true;
    this.abortController.abort();
    // OperationRunner.forceStop 是同步边界：这里只能执行不抛的同步销毁，异步清理继续由 run() 接管。
    this.destroyStreams();
    if (this.finalTargetCommit !== "committed") this.cleanupState = "unknown";
    this.phase = "terminal";
    return this.result();
  }

  private async run(): Promise<void> {
    try {
      const prepared = await this.backend.prepare(this.request, this.abortController.signal);
      this.prepared = prepared;
      const outcome = await runPreparedTransfer(prepared, {
        isStopping: () => this.stopping,
        onProgress: (transferredBytes, totalBytes) => {
          this.transferredBytes = transferredBytes;
          this.totalBytes = totalBytes;
          this.publishProgress();
        },
        onPhase: (phase) => {
          this.phase = phase;
          if (phase === "commit_started") this.finalTargetCommit = "unknown";
          if (phase === "committed") this.finalTargetCommit = "committed";
          this.publishProgress();
        }
      });
      this.cleanupState = outcome.temporaryCleanup;
      await this.finishCommitted();
    } catch (error: unknown) {
      await this.finishFailure(error);
    }
  }

  private async finishCommitted(): Promise<void> {
    this.phase = "closing";
    this.publishProgress();
    let closeFailed = false;
    try { await this.closeOnce(); } catch { closeFailed = true; }
    this.phase = "terminal";
    const details = {
      temporaryCleanup: this.cleanupState,
      ...(closeFailed ? { resourceClose: "failed" } : {}),
      ...(this.stopping ? { stopRequested: true, stopReason: this.stopReason } : {})
    };
    if (closeFailed || this.cleanupState === "failed" || this.cleanupState === "unknown") {
      this.publishTerminal(() => this.manager.partialFailure(
        this.operationId,
        this.error(ErrorCodes.PARTIAL_FAILURE, "partial_failure", this.cleanupState === "failed" ? "partial" : "confirmed", details),
        this.result(true)
      ));
      return;
    }
    this.publishTerminal(() => this.manager.complete(this.operationId, this.result(true)));
  }

  private async finishFailure(error: unknown): Promise<void> {
    const failedPhase = this.phase;
    this.destroyStreams();
    if (error instanceof TransferPreparationError) this.cleanupState = error.temporaryCleanup;
    const cleanupConfirmed = await this.cleanup();
    let closeConfirmed = !(error instanceof TransferPreparationError && error.resourceCloseFailed);
    try { await this.closeOnce(); } catch { closeConfirmed = false; }
    this.phase = "terminal";
    if (this.finalTargetCommit === "committed") {
      this.publishTerminal(() => this.manager.partialFailure(this.operationId,
        this.error(ErrorCodes.PARTIAL_FAILURE, "partial_failure", "confirmed", { resourceClose: "failed" }), this.result(true)));
      return;
    }
    const commitOutcomeUnknown = this.finalTargetCommit === "unknown" || failedPhase === "commit_started";
    if (this.stopping) {
      if (cleanupConfirmed && closeConfirmed && !commitOutcomeUnknown) {
        this.publishTerminal(() => this.manager.confirmStopped(this.operationId, this.result(), this.stopReason === "timeout"
          ? this.error(ErrorCodes.TRANSFER_TIMEOUT, "timed_out", "none") : undefined));
      } else {
        this.publishTerminal(() => this.manager.unknown(this.operationId, this.error(ErrorCodes.STATE_UNKNOWN, "unknown", "possible", {
          temporaryCleanup: this.cleanupState,
          ...(commitOutcomeUnknown ? { commitOutcome: "unknown" } : {}),
          ...(!closeConfirmed ? { resourceClose: "failed" } : {})
        }), this.result()));
      }
      return;
    }
    const code = errorCode(error);
    if (!cleanupConfirmed || !closeConfirmed || commitOutcomeUnknown) {
      this.publishTerminal(() => this.manager.unknown(this.operationId, this.error(ErrorCodes.STATE_UNKNOWN, "unknown", "possible", {
        cause: code,
        temporaryCleanup: this.cleanupState,
        ...(commitOutcomeUnknown ? { commitOutcome: "unknown" } : {}),
        ...(!closeConfirmed ? { resourceClose: "failed" } : {})
      }), this.result()));
      return;
    }
    this.publishTerminal(() => this.manager.fail(this.operationId, this.error(code, "failed", "none"), this.result()));
  }

  private async cleanup(): Promise<boolean> {
    if (this.prepared === undefined) {
      return this.cleanupState === "not_needed" || this.cleanupState === "removed";
    }
    try {
      const removed = await this.prepared.cleanup();
      this.cleanupState = removed ? "removed" : "failed";
      return removed;
    } catch {
      this.cleanupState = "unknown";
      return false;
    }
  }

  private async closeOnce(): Promise<void> {
    if (this.prepared === undefined) return;
    this.closePromise ??= this.prepared.close();
    await this.closePromise;
  }

  private destroyStreams(): void {
    try { this.prepared?.source.destroy(); } catch { /* 同步强制销毁必须不抛。 */ }
    try { this.prepared?.target.destroy(); } catch { /* 同步强制销毁必须不抛。 */ }
  }

  private publishProgress(): void {
    try {
      this.manager.updateResult(this.operationId, this.result());
    } catch (error: unknown) {
      if (!isUnavailableOperation(error)) throw error;
    }
  }

  private publishTerminal(action: () => OperationSnapshot): void {
    try {
      action();
    } catch (error: unknown) {
      if (!isUnavailableOperation(error)) throw error;
    }
  }

  /**
   * detached run 的最后一道终结边界：正常异常由 run/finishFailure 映射；若实现异常仍逃逸，
   * 将活跃 Operation 保守终结为 unknown。记录已终态或已过期时只结束后台 Promise。
   */
  private terminateBackgroundRun(error: unknown): void {
    if (isUnavailableOperation(error)) return;
    this.phase = "terminal";
    try {
      this.publishTerminal(() => this.manager.unknown(this.operationId,
        this.error(ErrorCodes.STATE_UNKNOWN, "unknown", "possible", {
          cause: errorCode(error),
          backgroundTermination: "failed"
        }), this.result()));
    } catch {
      // detached 边界不能再次形成未处理拒绝；非 Operation 可用性异常已尽力持久化为 unknown。
    }
  }

  private result(completed = false): TransferResult {
    return Object.freeze({
      direction: this.request.direction,
      host: this.request.host.alias,
      source: this.request.source,
      target: this.request.target,
      transferredBytes: this.transferredBytes,
      ...(this.totalBytes === undefined ? {} : { totalBytes: this.totalBytes }),
      completedItems: completed ? 1 as const : 0 as const,
      temporaryCleanup: this.cleanupState,
      phase: this.phase,
      finalTargetCommit: this.finalTargetCommit,
      stopRequested: this.stopping,
      ...(this.stopReason === undefined ? {} : { stopReason: this.stopReason })
    });
  }

  private error(
    code: McpOperationError["code"], finalState: McpOperationError["finalState"],
    sideEffects: McpOperationError["sideEffects"], details?: Readonly<Record<string, unknown>>
  ): McpOperationError {
    return createMcpOperationError({
      code, message: code, finalState, retriable: false, sideEffects,
      operationId: this.operationId, host: this.request.host.alias, details
    }, undefined, { allowedOperationIds: new Set([this.operationId]), allowedHosts: new Set([this.request.host.alias]) });
  }
}

function checkedSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("源文件大小无效");
  return value;
}
function errorCode(error: unknown): McpOperationError["code"] {
  if (error instanceof TransferPreparationError) return errorCode(error.originalError);
  return error instanceof Error && "code" in error && isErrorCode(error.code) ? error.code : ErrorCodes.TRANSFER_FAILED;
}

function isUnavailableOperation(error: unknown): boolean {
  return error instanceof OperationManagerError
    && (error.code === ErrorCodes.OPERATION_EXPIRED || error.code === ErrorCodes.OPERATION_NOT_FOUND);
}
