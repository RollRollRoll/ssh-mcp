import path from "node:path";
import type { Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { ErrorCodes, type ErrorCode } from "../errors/error-codes.js";
import type { PathPlatform } from "../paths/path-guard.js";

export interface TemporaryWriter {
  readonly stream: Writable;
  seal(): Promise<void>;
  forceDestroy(): void;
  stop(): Promise<void>;
}

export interface AtomicTargetPort {
  inspect(path: string): Promise<"absent" | "file">;
  supportsAtomicReplace(): boolean;
  supportsNoReplace(): boolean;
  openExclusive(path: string): Promise<TemporaryWriter>;
  commitNoReplace(temporaryPath: string, finalPath: string): Promise<boolean>;
  commitReplace(temporaryPath: string, finalPath: string): Promise<boolean>;
  remove(path: string): Promise<void>;
}

export class AtomicTargetError extends Error {
  public constructor(public readonly code: ErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "AtomicTargetError";
  }
}

/** 同目录临时文件只由服务生成；提交前不会触碰最终目标。 */
export class AtomicTarget {
  public readonly temporaryPath: string;
  private writer: TemporaryWriter | undefined;
  private openAttempted = false;
  private existed = false;
  private sealed = false;
  private committed = false;

  public constructor(
    public readonly finalPath: string,
    private readonly overwrite: boolean,
    private readonly platform: PathPlatform,
    private readonly port: AtomicTargetPort,
    idFactory: () => string = randomUUID
  ) {
    const library = platform === "posix" ? path.posix : path.win32;
    this.temporaryPath = library.join(library.dirname(finalPath), `.ssh-mcp-${idFactory()}.part`);
  }

  public async open(): Promise<Writable> {
    const status = await this.port.inspect(this.finalPath);
    this.existed = status === "file";
    if (this.existed && !this.overwrite) throw new AtomicTargetError(ErrorCodes.TARGET_EXISTS);
    if (!this.existed && !this.port.supportsNoReplace()) {
      throw new AtomicTargetError(ErrorCodes.ATOMIC_REPLACE_UNSUPPORTED);
    }
    if (this.existed && !this.port.supportsAtomicReplace()) {
      throw new AtomicTargetError(ErrorCodes.ATOMIC_REPLACE_UNSUPPORTED);
    }
    try {
      this.openAttempted = true;
      this.writer = await this.port.openExclusive(this.temporaryPath);
      return this.writer.stream;
    } catch (error: unknown) {
      throw new AtomicTargetError(ErrorCodes.TRANSFER_FAILED, { cause: error });
    }
  }

  public async seal(): Promise<void> {
    if (this.writer === undefined || this.committed) throw new AtomicTargetError(ErrorCodes.TRANSFER_FAILED);
    if (this.sealed) return;
    await this.writer.seal();
    this.sealed = true;
  }

  public async commit(): Promise<"not_needed" | "failed"> {
    if (this.writer === undefined || !this.sealed || this.committed) throw new AtomicTargetError(ErrorCodes.TRANSFER_FAILED);
    try {
      const temporaryRemoved = this.existed
        ? await this.port.commitReplace(this.temporaryPath, this.finalPath)
        : await this.port.commitNoReplace(this.temporaryPath, this.finalPath);
      this.committed = true;
      return temporaryRemoved ? "not_needed" : "failed";
    } catch (error: unknown) {
      const code = isTargetExists(error) ? ErrorCodes.TARGET_EXISTS : ErrorCodes.TRANSFER_FAILED;
      throw new AtomicTargetError(code, { cause: error });
    }
  }

  public destroy(): void { this.writer?.forceDestroy(); }

  /** openExclusive 已开始后，即使调用失败也必须把临时路径视为可能存在。 */
  public get temporaryMayExist(): boolean { return this.openAttempted && !this.committed; }

  public async cleanup(): Promise<boolean> {
    if (this.committed || !this.openAttempted) return true;
    await this.writer?.stop();
    try { await this.port.remove(this.temporaryPath); return true; } catch (error: unknown) {
      if (hasUnknownCleanupOutcome(error)) throw error;
      return isNotFound(error);
    }
  }
}

function isTargetExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "EEXIST" || error.code === 4 || error.code === "4");
}
function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === 2 || error.code === "2");
}

function hasUnknownCleanupOutcome(error: unknown): boolean {
  return error instanceof Error && "cleanupOutcome" in error && error.cleanupOutcome === "unknown";
}
