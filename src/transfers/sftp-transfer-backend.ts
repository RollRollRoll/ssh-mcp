import { constants } from "node:fs";
import { link, lstat, open, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { Writable as NodeWritable, type Readable, type Writable } from "node:stream";
import { AtomicTarget, AtomicTargetError, type AtomicTargetPort, type TemporaryWriter } from "./atomic-target.js";
import {
  TransferPreparationError,
  type PreparedTransfer,
  type TemporaryCleanupState,
  type TransferBackend,
  type TransferRequest
} from "./file-transfer.js";
import { LocalPathGuard } from "../paths/local-path-guard.js";
import { LinuxPathGuard, type RemoteSafePathHandle } from "../paths/linux-path-guard.js";
import { WindowsPathGuard } from "../paths/windows-path-guard.js";
import { WindowsReparseProbe } from "../paths/windows-reparse-probe.js";
import { PathGuardError, type PathPlatform } from "../paths/path-guard.js";
import { ErrorCodes } from "../errors/error-codes.js";
import type { SftpTransferSession, SshAdapter, SshConnection } from "../ssh/ssh-adapter.js";

export interface SftpTransferBackendOptions {
  readonly localPlatform?: PathPlatform;
  readonly temporaryIdFactory?: () => string;
}

/** 在获批后建立一次性 SSH/SFTP 连接，并为单个普通文件准备安全流。 */
export class SftpTransferBackend implements TransferBackend {
  private readonly localPlatform: PathPlatform;
  public constructor(
    private readonly adapter: Pick<SshAdapter, "connect">,
    private readonly localRoots: readonly string[],
    private readonly options: SftpTransferBackendOptions = {}
  ) {
    this.localPlatform = options.localPlatform ?? (process.platform === "win32" ? "win32" : "posix");
  }

  public async prepare(request: TransferRequest, signal: AbortSignal): Promise<PreparedTransfer> {
    const resources = new ResourceClosers();
    let connection: SshConnection | undefined;
    let sftp: SftpTransferSession | undefined;
    try {
      throwIfAborted(signal);
      connection = await this.adapter.connect(request.host);
      resources.add(() => connection!.close());
      throwIfAborted(signal);
      sftp = await openSftp(connection);
      resources.add(() => sftp!.close());
      throwIfAborted(signal);
      return request.direction === "upload"
        ? await this.prepareUpload(request, connection, sftp, signal, resources)
        : await this.prepareDownload(request, connection, sftp, signal, resources);
    } catch (error: unknown) {
      let resourceCloseFailed = false;
      try { await resources.closeAll(); } catch { resourceCloseFailed = true; }
      if (error instanceof TransferPreparationError) {
        throw new TransferPreparationError(error.originalError, error.temporaryCleanup, resourceCloseFailed || error.resourceCloseFailed);
      }
      if (resourceCloseFailed) throw new TransferPreparationError(error, "not_needed", true);
      throw error;
    }
  }

  private async prepareUpload(
    request: TransferRequest,
    connection: SshConnection,
    sftp: SftpTransferSession,
    signal: AbortSignal,
    resources: ResourceClosers
  ): Promise<PreparedTransfer> {
    const remote = await this.remoteGuard(request, connection, sftp, request.target);
    throwIfAborted(signal);
    const atomic = new AtomicTarget(remote.canonical, request.overwrite, request.host.platform === "linux" ? "posix" : "win32",
      new RemoteAtomicPort(sftp, remote), this.options.temporaryIdFactory);
    let target: Writable | undefined;
    try {
      target = await atomic.open();
      throwIfAborted(signal);
      const local = await new LocalPathGuard(this.localRoots, { platform: this.localPlatform }).verify(request.source);
      throwIfAborted(signal);
      const file = await local.openReadOnly();
      resources.add(async () => await file.close());
      const status = await file.stat();
      if (!status.isFile() || !Number.isSafeInteger(status.size) || status.size! < 0 || file.createReadStream === undefined) {
        throw new PathGuardError();
      }
      const source = file.createReadStream({ autoClose: false });
      throwIfAborted(signal);
      return prepared(source, target, status.size!, atomic, resources);
    } catch (error: unknown) {
      try { target?.destroy(); } catch { /* 同步销毁失败由清理证据收口。 */ }
      if (atomic.temporaryMayExist) {
        throw new TransferPreparationError(error, await cleanupPreparationTarget(atomic));
      }
      throw error;
    }
  }

  private async prepareDownload(
    request: TransferRequest,
    connection: SshConnection,
    sftp: SftpTransferSession,
    signal: AbortSignal,
    resources: ResourceClosers
  ): Promise<PreparedTransfer> {
    const remote = await this.remoteGuard(request, connection, sftp, request.source);
    throwIfAborted(signal);
    await remote.revalidateBeforeOpen();
    const sourceStatus = await sftp.lstat(remote.canonical);
    if (sourceStatus.kind !== "file" || !Number.isSafeInteger(sourceStatus.size) || sourceStatus.size < 0) throw new PathGuardError();
    const source = sftp.createReadStream(remote.canonical);

    const local = await new LocalPathGuard(this.localRoots, { platform: this.localPlatform }).verify(request.target);
    throwIfAborted(signal);
    const atomic = new AtomicTarget(local.canonical, request.overwrite, this.localPlatform,
      new LocalAtomicPort(local), this.options.temporaryIdFactory);
    let target: Writable | undefined;
    try {
      target = await atomic.open();
      throwIfAborted(signal);
      return prepared(source, target, sourceStatus.size, atomic, resources);
    } catch (error: unknown) {
      try { source.destroy(); } catch { /* 后续资源关闭仍会执行。 */ }
      if (atomic.temporaryMayExist) {
        try { target?.destroy(); } catch { /* 清理结果决定终态。 */ }
        throw new TransferPreparationError(error, await cleanupPreparationTarget(atomic));
      }
      throw error;
    }
  }

  private async remoteGuard(request: TransferRequest, connection: SshConnection, sftp: SftpTransferSession, target: string): Promise<RemoteSafePathHandle> {
    if (request.host.platform === "linux") return await new LinuxPathGuard(request.host.remoteRoots, sftp).verify(target);
    const probe = new WindowsReparseProbe({ execute: async (command) => await executeProbe(connection, command) }, request.host.shell.command);
    return await new WindowsPathGuard(request.host.remoteRoots, sftp, probe).verify(target);
  }
}

function prepared(
  source: Readable,
  target: Writable,
  totalBytes: number,
  atomic: AtomicTarget,
  resources: ResourceClosers
): PreparedTransfer {
  return {
    source, target, totalBytes,
    seal: async () => await atomic.seal(),
    commit: async () => await atomic.commit(),
    cleanup: async () => await atomic.cleanup(),
    close: async () => {
      const errors: unknown[] = [];
      try { atomic.destroy(); } catch (error: unknown) { errors.push(error); }
      try { await resources.closeAll(); } catch (error: unknown) { errors.push(error); }
      if (errors.length > 0) throw new AggregateError(errors, "传输资源关闭失败");
    }
  };
}

class LocalAtomicPort implements AtomicTargetPort {
  public constructor(private readonly safeTarget: { revalidateBeforeOpen(): Promise<void> }) {}
  public async inspect(target: string): Promise<"absent" | "file"> {
    try {
      const status = await lstat(target);
      if (status.isSymbolicLink()) throw new PathGuardError(ErrorCodes.LINK_NOT_ALLOWED);
      if (!status.isFile()) throw new PathGuardError();
      return "file";
    } catch (error: unknown) {
      if (isNotFound(error)) return "absent";
      throw error;
    }
  }
  public supportsAtomicReplace(): boolean { return true; }
  public supportsNoReplace(): boolean { return true; }
  public async openExclusive(target: string): Promise<TemporaryWriter> {
    await this.safeTarget.revalidateBeforeOpen();
    const handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW), 0o600);
    return localWriter(handle);
  }
  public async commitNoReplace(source: string, target: string): Promise<boolean> { await link(source, target); try { await unlink(source); return true; } catch { return false; } }
  public async commitReplace(source: string, target: string): Promise<boolean> { await rename(source, target); return true; }
  public async remove(target: string): Promise<void> { await unlink(target); }
}

class RemoteAtomicPort implements AtomicTargetPort {
  public constructor(private readonly sftp: SftpTransferSession, private readonly safeTarget: RemoteSafePathHandle) {}
  public async inspect(target: string): Promise<"absent" | "file"> {
    try {
      const status = await this.sftp.lstat(target);
      if (status.kind === "symlink") throw new PathGuardError(ErrorCodes.LINK_NOT_ALLOWED);
      if (status.kind !== "file") throw new PathGuardError();
      return "file";
    } catch (error: unknown) {
      if (isNotFound(error)) return "absent";
      throw error;
    }
  }
  public supportsAtomicReplace(): boolean { return this.sftp.supportsAtomicReplace; }
  public supportsNoReplace(): boolean { return this.sftp.supportsHardlink; }
  public async openExclusive(target: string): Promise<TemporaryWriter> {
    await this.safeTarget.revalidateBeforeOpen();
    const stream = this.sftp.createWriteStream(target);
    return {
      stream,
      seal: async () => undefined,
      forceDestroy: () => { stream.destroy(); },
      stop: async () => await destroyStream(stream)
    };
  }
  public async commitNoReplace(source: string, target: string): Promise<boolean> {
    try { await this.sftp.hardlink(source, target); } catch (error: unknown) {
      try { await this.sftp.lstat(target); throw Object.assign(new Error("目标已存在"), { code: "EEXIST" }); } catch (statusError: unknown) {
        if (statusError instanceof Error && "code" in statusError && statusError.code === "EEXIST") throw statusError;
        throw error;
      }
    }
    try { await this.sftp.unlink(source); return true; } catch { return false; }
  }
  public async commitReplace(source: string, target: string): Promise<boolean> { await this.sftp.atomicReplace(source, target); return true; }
  public async remove(target: string): Promise<void> { await this.sftp.unlink(target); }
}

function localWriter(handle: FileHandle): TemporaryWriter {
  // 用显式 FileHandle.write 保留 fsync 能力，同时让 pipeline 只等待标准 Writable 的 finish。
  const stream = new NodeWritable({
    write: (chunk: Buffer | string, _encoding, callback) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      void writeAll(handle, data).then(() => callback(), callback);
    }
  });
  let sealed = false;
  let closePromise: Promise<void> | undefined;
  const closeHandle = async (): Promise<void> => {
    closePromise ??= handle.close();
    await closePromise;
  };
  return {
    stream,
    seal: async () => { if (sealed) return; await handle.sync(); await closeHandle(); sealed = true; },
    forceDestroy: () => { try { stream.destroy(); } catch { /* 同步边界不得抛出。 */ } },
    stop: async () => { try { stream.destroy(); } catch { /* 仍须等待句柄关闭。 */ } await closeHandle(); }
  };
}

class ResourceClosers {
  private readonly entries: Array<{ closed: boolean; close: () => void | Promise<void> }> = [];
  public add(close: () => void | Promise<void>): void { this.entries.push({ closed: false, close }); }
  public async closeAll(): Promise<void> {
    const errors: unknown[] = [];
    for (const entry of [...this.entries].reverse()) {
      if (entry.closed) continue;
      entry.closed = true;
      try { await entry.close(); } catch (error: unknown) { errors.push(error); }
    }
    if (errors.length > 0) throw new AggregateError(errors, "传输资源关闭失败");
  }
}

async function cleanupPreparationTarget(atomic: AtomicTarget): Promise<TemporaryCleanupState> {
  try { return await atomic.cleanup() ? "removed" : "failed"; } catch { return "unknown"; }
}

async function writeAll(handle: FileHandle, data: Buffer): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(data, offset, data.length - offset, null);
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) throw new Error("本地临时文件写入未前进");
    offset += bytesWritten;
  }
}

async function destroyStream(stream: Writable): Promise<void> {
  if (stream.closed) return;
  await new Promise<void>((resolve) => {
    const done = (): void => { stream.removeListener("close", done); stream.removeListener("error", done); resolve(); };
    stream.once("close", done); stream.once("error", done);
    if (!stream.destroyed) stream.destroy();
  });
}

async function openSftp(connection: SshConnection): Promise<SftpTransferSession> {
  if (connection.openSftp === undefined) throw new AtomicTargetError(ErrorCodes.TRANSFER_FAILED);
  return await new Promise((resolve, reject) => connection.openSftp!((error, sftp) => error === undefined ? resolve(sftp) : reject(error)));
}

async function executeProbe(connection: SshConnection, command: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return await new Promise((resolve, reject) => connection.exec(command, (error, rawChannel) => {
    if (error !== undefined) { reject(error); return; }
    const channel = rawChannel as unknown as {
      stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): void };
      on(event: "data", listener: (chunk: Buffer | string) => void): void;
      on(event: "error", listener: (error: Error) => void): void;
      on(event: "close", listener: (code: number | null | undefined) => void): void;
    };
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    channel.on("data", (chunk) => stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    channel.stderr.on("data", (chunk) => stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    channel.on("error", reject);
    channel.on("close", (code) => resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), code: code ?? -1 }));
  }));
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === 2 || error.code === "2");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw Object.assign(new Error("传输已取消"), { code: ErrorCodes.TRANSFER_FAILED });
}
