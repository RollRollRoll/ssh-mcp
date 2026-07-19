import { ErrorCodes, isErrorCode, type ErrorCode } from "../errors/error-codes.js";
import { createMcpOperationError, type McpOperationError } from "../errors/error-contract.js";
import {
  OperationManager,
  OperationManagerError,
  type OperationRunner,
  type OperationSnapshot
} from "../operations/operation-manager.js";
import { validateRelativePath, type DirectoryWalkEntry } from "./directory-walker.js";
import { runPreparedTransfer, TransferPreparationError, type PreparedTransfer, type TransferRequest } from "./file-transfer.js";

export interface PreparedDirectoryTransfer {
  readonly entries: readonly DirectoryWalkEntry[];
  createTargetRoot(): Promise<void>;
  createDirectory(entry: DirectoryWalkEntry): Promise<void>;
  prepareFile(entry: DirectoryWalkEntry, signal: AbortSignal): Promise<PreparedTransfer>;
  close(): Promise<void>;
}

export interface DirectoryTransferBackend {
  prepare(request: TransferRequest, signal: AbortSignal): Promise<PreparedDirectoryTransfer>;
}

export class DirectoryTransferSetupError extends Error {
  public constructor(public readonly code: ErrorCode) {
    super(code);
    this.name = "DirectoryTransferSetupError";
  }
}

export interface DirectoryFailure extends Readonly<Record<string, unknown>> {
  readonly relativePath: string;
  readonly code: ErrorCode;
  readonly safety: "confirmed" | "unknown";
}

export interface DirectoryIssue extends Readonly<Record<string, unknown>> {
  readonly relativePath?: string;
  readonly code: typeof ErrorCodes.PARTIAL_FAILURE;
  readonly kind: "cleanup" | "close" | "directory_create";
  readonly cause?: ErrorCode;
  readonly targetCreation?: "unknown";
  readonly temporaryCleanup?: "failed" | "unknown";
  readonly resourceCloseFailed?: true;
}

export interface DirectoryTransferResult extends Readonly<Record<string, unknown>> {
  readonly direction: "upload" | "download";
  readonly host: string;
  readonly source: string;
  readonly target: string;
  readonly currentItem?: string;
  readonly transferredBytes: number;
  readonly totalBytes?: number;
  readonly aggregateTransferredBytes: number;
  readonly completedItems: number;
  readonly totalItems: number;
  readonly succeeded: readonly string[];
  readonly failed: readonly DirectoryFailure[];
  readonly notExecuted: readonly string[];
  readonly issues: readonly DirectoryIssue[];
  readonly stopRequested: boolean;
  readonly stopReason?: "cancel" | "timeout";
}

/** 一个目录对应一个 Operation；目录内始终按稳定顺序逐项执行。 */
export class DirectoryTransferService {
  public constructor(private readonly manager: OperationManager, private readonly backend: DirectoryTransferBackend) {}

  public start(request: TransferRequest): OperationSnapshot {
    if (!request.recursive) throw new TypeError("目录服务只接受 recursive=true");
    return new DirectoryTransferExecution(this.manager, this.backend, request).start();
  }
}

class DirectoryTransferExecution implements OperationRunner {
  private operationId = "";
  private preparedDirectory: PreparedDirectoryTransfer | undefined;
  private current: PreparedTransfer | undefined;
  private currentItem: string | undefined;
  private filePrepareStarted = false;
  private transferredBytes = 0;
  private totalBytes: number | undefined;
  private aggregateTransferredBytes = 0;
  private totalItems = 0;
  private targetCreated = false;
  private targetCreationAttempted = false;
  private stopping = false;
  private stopReason: "cancel" | "timeout" | undefined;
  private commitState: "not_started" | "started" | "committed" = "not_started";
  private closePromise: Promise<void> | undefined;
  private readonly succeeded: string[] = [];
  private readonly failed: DirectoryFailure[] = [];
  private readonly notExecuted: string[] = [];
  private readonly issues: DirectoryIssue[] = [];
  private readonly abortController = new AbortController();

  public constructor(
    private readonly manager: OperationManager,
    private readonly backend: DirectoryTransferBackend,
    private readonly request: TransferRequest
  ) {}

  public start(): OperationSnapshot {
    const snapshot = this.manager.create({ initialState: "running", runner: this, timeoutKind: "transfer" });
    this.operationId = snapshot.operationId;
    this.publish();
    queueMicrotask(() => void this.run().catch((error: unknown) => this.backgroundFailure(error)));
    return snapshot;
  }

  public cancel(reason: "cancel" | "timeout"): void {
    if (this.stopping) return;
    this.stopping = true;
    this.stopReason = reason;
    this.abortController.abort();
    this.destroyCurrent();
    this.publish();
  }

  public forceStop(): Readonly<Record<string, unknown>> {
    this.stopping = true;
    this.abortController.abort();
    this.destroyCurrent();
    if (this.currentItem !== undefined && this.filePrepareStarted && !this.succeeded.includes(this.currentItem)) {
      this.recordFailure(this.currentItem, ErrorCodes.STATE_UNKNOWN, "unknown");
    }
    this.completeNotExecuted();
    return this.result();
  }

  private async run(): Promise<void> {
    try {
      const directory = await this.backend.prepare(this.request, this.abortController.signal);
      this.preparedDirectory = directory;
      const files = directory.entries.filter((entry) => entry.kind === "file");
      this.totalItems = files.length;
      this.assertEntries(directory.entries);
      if (this.stopping) {
        this.completeNotExecuted();
        return await this.finishStopped(await this.closeCurrentAndDirectory());
      }
      this.targetCreationAttempted = true;
      await directory.createTargetRoot();
      this.targetCreated = true;
      this.publish();
      for (const entry of directory.entries) {
        if (this.stopping) break;
        if (entry.kind === "directory") {
          this.currentItem = entry.relativePath;
          this.transferredBytes = 0;
          this.totalBytes = undefined;
          this.publish();
          try { await directory.createDirectory(entry); }
          catch (error: unknown) {
            if (isTargetCreationUnknown(error)) {
              this.issues.push(Object.freeze({
                relativePath: entry.relativePath, code: ErrorCodes.PARTIAL_FAILURE,
                kind: "directory_create", cause: ErrorCodes.STATE_UNKNOWN, targetCreation: "unknown"
              }));
              this.completeNotExecuted();
              await this.closeCurrentAndDirectory();
              this.finishUnknown(ErrorCodes.STATE_UNKNOWN);
              return;
            }
            this.issues.push(Object.freeze({
              relativePath: entry.relativePath, code: ErrorCodes.PARTIAL_FAILURE,
              kind: "directory_create", cause: errorCode(error)
            }));
            break;
          }
          continue;
        }
        await this.transferFile(entry);
        if (this.failed.length > 0 || this.issues.length > 0) break;
      }
      this.completeNotExecuted();
      if (this.stopping) return await this.finishStopped(await this.closeCurrentAndDirectory());
      if (this.failed.length > 0 || this.issues.length > 0) return await this.finishPartial(await this.closeCurrentAndDirectory());
      const closeConfirmed = await this.closeCurrentAndDirectory();
      if (!closeConfirmed) {
        this.issues.push(Object.freeze({ code: ErrorCodes.PARTIAL_FAILURE, kind: "close" }));
        return await this.finishPartial(true);
      }
      this.manager.complete(this.operationId, this.result());
    } catch (error: unknown) {
      this.completeNotExecuted();
      const closeConfirmed = await this.closeCurrentAndDirectory();
      if (this.stopping) return await this.finishStopped(closeConfirmed);
      if (isTargetCreationUnknown(error) || (this.targetCreationAttempted && !isConfirmedNoSideEffect(error) && !this.targetCreated)) {
        return this.finishUnknown(ErrorCodes.STATE_UNKNOWN);
      }
      if (this.targetCreated) {
        this.recordFailure(this.currentItem ?? firstUnclassified(this.filePaths(), this.succeeded, this.failed, this.notExecuted) ?? "", errorCode(error), closeConfirmed ? "confirmed" : "unknown");
        this.completeNotExecuted();
        return await this.finishPartial(closeConfirmed);
      }
      if (!closeConfirmed) return this.finishUnknown(ErrorCodes.STATE_UNKNOWN);
      this.manager.fail(this.operationId, this.error(errorCode(error), "failed", "none"), this.result());
    }
  }

  private async transferFile(entry: DirectoryWalkEntry): Promise<void> {
    this.currentItem = entry.relativePath;
    this.transferredBytes = 0;
    this.totalBytes = entry.size;
    this.resetCommitState();
    this.filePrepareStarted = true;
    this.publish();
    let cleanupConfirmed = true;
    let closeConfirmed = true;
    try {
      const prepared = await this.preparedDirectory!.prepareFile(entry, this.abortController.signal);
      this.current = prepared;
      const outcome = await runPreparedTransfer(prepared, {
        isStopping: () => this.stopping,
        onProgress: (transferredBytes, totalBytes) => {
          this.transferredBytes = transferredBytes;
          this.totalBytes = totalBytes;
          this.publish();
        },
        onPhase: (phase) => { this.observeFilePhase(phase); }
      });
      this.aggregateTransferredBytes = checkedAdd(this.aggregateTransferredBytes, this.transferredBytes);
      this.succeeded.push(entry.relativePath);
      if (outcome.temporaryCleanup === "failed") {
        this.issues.push(Object.freeze({ relativePath: entry.relativePath, code: ErrorCodes.PARTIAL_FAILURE, kind: "cleanup" }));
      }
      try { await prepared.close(); }
      catch { this.issues.push(Object.freeze({ relativePath: entry.relativePath, code: ErrorCodes.PARTIAL_FAILURE, kind: "close" })); }
      this.current = undefined;
      this.filePrepareStarted = false;
      this.publish();
      return;
    } catch (error: unknown) {
      this.destroyCurrent();
      if (error instanceof TransferPreparationError) {
        if (error.temporaryCleanup === "failed" || error.temporaryCleanup === "unknown") {
          cleanupConfirmed = false;
          this.issues.push(Object.freeze({
            relativePath: entry.relativePath, code: ErrorCodes.PARTIAL_FAILURE,
            kind: "cleanup", temporaryCleanup: error.temporaryCleanup
          }));
        }
        if (error.resourceCloseFailed) {
          closeConfirmed = false;
          this.issues.push(Object.freeze({
            relativePath: entry.relativePath, code: ErrorCodes.PARTIAL_FAILURE,
            kind: "close", resourceCloseFailed: true
          }));
        }
      }
      if (this.current !== undefined && this.commitState !== "committed") {
        try { cleanupConfirmed = await this.current.cleanup(); } catch { cleanupConfirmed = false; }
      }
      if (this.current !== undefined) {
        try { await this.current.close(); } catch { closeConfirmed = false; }
      }
      this.current = undefined;
      this.filePrepareStarted = false;
      const unknown = !cleanupConfirmed || !closeConfirmed || this.commitState === "started";
      if (this.commitState === "committed" && !this.succeeded.includes(entry.relativePath)) {
        this.aggregateTransferredBytes = checkedAdd(this.aggregateTransferredBytes, this.transferredBytes);
        this.succeeded.push(entry.relativePath);
      } else if (!this.succeeded.includes(entry.relativePath)) {
        this.recordFailure(entry.relativePath, errorCode(error), unknown ? "unknown" : "confirmed");
      }
      this.publish();
    }
  }

  private observeFilePhase(phase: "streaming" | "sealing" | "commit_started" | "committed"): void {
    if (phase === "commit_started") this.commitState = "started";
    if (phase === "committed") this.commitState = "committed";
  }

  private resetCommitState(): void { this.commitState = "not_started"; }

  private async finishStopped(confirmed: boolean): Promise<void> {
    if (!confirmed || this.failed.some((failure) => failure.safety === "unknown")) {
      this.finishUnknown(ErrorCodes.STATE_UNKNOWN);
      return;
    }
    this.manager.confirmStopped(this.operationId, this.result(), this.stopReason === "timeout"
      ? this.error(ErrorCodes.TRANSFER_TIMEOUT, "timed_out", this.targetCreated ? "partial" : "none")
      : undefined);
  }

  private async finishPartial(closeConfirmed: boolean): Promise<void> {
    if (!closeConfirmed || this.failed.some((failure) => failure.safety === "unknown")) {
      this.finishUnknown(ErrorCodes.STATE_UNKNOWN);
      return;
    }
    this.manager.partialFailure(this.operationId,
      this.error(ErrorCodes.PARTIAL_FAILURE, "partial_failure", this.targetCreated ? "partial" : "none"), this.result());
  }

  private finishUnknown(code: ErrorCode): void {
    this.manager.unknown(this.operationId, this.error(code, "unknown", this.targetCreated ? "partial" : "possible"), this.result());
  }

  private async closeCurrentAndDirectory(): Promise<boolean> {
    let confirmed = true;
    if (this.current !== undefined) {
      try { await this.current.close(); } catch { confirmed = false; }
      this.current = undefined;
    }
    if (this.preparedDirectory !== undefined) {
      try {
        this.closePromise ??= this.preparedDirectory.close();
        await this.closePromise;
      } catch { confirmed = false; }
    }
    return confirmed;
  }

  private destroyCurrent(): void {
    try { this.current?.source.destroy(); } catch { /* 同步停止边界不得抛。 */ }
    try { this.current?.target.destroy(); } catch { /* 同步停止边界不得抛。 */ }
  }

  private assertEntries(entries: readonly DirectoryWalkEntry[]): void {
    let previous: string | undefined;
    const seen = new Map<string, "file" | "directory">();
    for (const entry of entries) {
      try { validateRelativePath(entry.relativePath); } catch { throw new DirectoryTransferSetupError(ErrorCodes.PATH_DENIED); }
      if ((previous !== undefined && previous >= entry.relativePath) || seen.has(entry.relativePath)
        || (entry.kind !== "file" && entry.kind !== "directory")
        || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new DirectoryTransferSetupError(ErrorCodes.PATH_DENIED);
      const segments = entry.relativePath.split("/");
      for (let index = 1; index < segments.length; index += 1) {
        if (seen.get(segments.slice(0, index).join("/")) !== "directory") throw new DirectoryTransferSetupError(ErrorCodes.PATH_DENIED);
      }
      previous = entry.relativePath;
      seen.set(entry.relativePath, entry.kind);
    }
  }

  private recordFailure(relativePath: string, code: ErrorCode, safety: "confirmed" | "unknown"): void {
    if (relativePath.length === 0 || this.failed.some((failure) => failure.relativePath === relativePath)) return;
    this.failed.push(Object.freeze({ relativePath, code, safety }));
  }

  private completeNotExecuted(): void {
    const classified = new Set([...this.succeeded, ...this.failed.map((failure) => failure.relativePath), ...this.notExecuted]);
    for (const path of this.filePaths()) if (!classified.has(path)) this.notExecuted.push(path);
  }

  private filePaths(): string[] {
    return this.preparedDirectory?.entries.filter((entry) => entry.kind === "file").map((entry) => entry.relativePath) ?? [];
  }

  private publish(): void {
    try { this.manager.updateResult(this.operationId, this.result()); }
    catch (error: unknown) { if (!isUnavailable(error)) throw error; }
  }

  private result(): DirectoryTransferResult {
    return Object.freeze({
      direction: this.request.direction, host: this.request.host.alias, source: this.request.source, target: this.request.target,
      ...(this.currentItem === undefined ? {} : { currentItem: this.currentItem }),
      transferredBytes: this.transferredBytes,
      ...(this.totalBytes === undefined ? {} : { totalBytes: this.totalBytes }),
      aggregateTransferredBytes: this.aggregateTransferredBytes,
      completedItems: this.succeeded.length, totalItems: this.totalItems,
      succeeded: Object.freeze([...this.succeeded]), failed: Object.freeze([...this.failed]), notExecuted: Object.freeze([...this.notExecuted]),
      issues: Object.freeze([...this.issues]),
      stopRequested: this.stopping,
      ...(this.stopReason === undefined ? {} : { stopReason: this.stopReason })
    });
  }

  private error(code: ErrorCode, finalState: McpOperationError["finalState"], sideEffects: McpOperationError["sideEffects"]): McpOperationError {
    return createMcpOperationError({
      code, message: code, finalState, retriable: false, sideEffects,
      operationId: this.operationId, host: this.request.host.alias
    }, undefined, { allowedOperationIds: new Set([this.operationId]), allowedHosts: new Set([this.request.host.alias]) });
  }

  private backgroundFailure(error: unknown): void {
    if (isUnavailable(error)) return;
    try { this.finishUnknown(errorCode(error)); } catch { /* 后台边界不得产生未处理拒绝。 */ }
  }
}

function checkedAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("累计计数溢出");
  return value;
}
function errorCode(error: unknown): ErrorCode {
  if (error instanceof TransferPreparationError) return errorCode(error.originalError);
  if (error instanceof DirectoryTransferSetupError) return error.code;
  return error instanceof Error && "code" in error && isErrorCode(error.code) ? error.code : ErrorCodes.TRANSFER_FAILED;
}
function isUnavailable(error: unknown): boolean {
  return error instanceof OperationManagerError
    && (error.code === ErrorCodes.OPERATION_NOT_FOUND || error.code === ErrorCodes.OPERATION_EXPIRED);
}
function firstUnclassified(all: readonly string[], succeeded: readonly string[], failed: readonly DirectoryFailure[], notExecuted: readonly string[]): string | undefined {
  const known = new Set([...succeeded, ...failed.map((entry) => entry.relativePath), ...notExecuted]);
  return all.find((path) => !known.has(path));
}
function isTargetCreationUnknown(error: unknown): boolean {
  return error instanceof Error && "targetCreation" in error && error.targetCreation === "unknown";
}
function isConfirmedNoSideEffect(error: unknown): boolean {
  return error instanceof DirectoryTransferSetupError || (error instanceof Error && "targetCreation" in error && error.targetCreation === "none");
}
