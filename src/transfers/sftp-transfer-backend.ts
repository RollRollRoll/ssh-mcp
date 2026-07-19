import { constants } from "node:fs";
import path from "node:path";
import { link, lstat, open, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { Writable as NodeWritable, type Readable, type Writable } from "node:stream";
import { AtomicTarget, type AtomicTargetPort, type TemporaryWriter } from "./atomic-target.js";
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
import { MAX_WINDOWS_REPARSE_PROBE_STDOUT_BYTES, WindowsReparseProbe } from "../paths/windows-reparse-probe.js";
import { executeBoundedProbe } from "../ssh/bounded-probe.js";
import { PathGuardError, type PathPlatform } from "../paths/path-guard.js";
import { ErrorCodes } from "../errors/error-codes.js";
import {
  SftpOpenedReadFileError,
  type SftpTransferSession,
  type SftpTransferStat,
  type SshAdapter,
  type SshConnection
} from "../ssh/ssh-adapter.js";
import { AbortableSftpConnection } from "./abortable-sftp.js";

export interface SftpTransferBackendOptions {
  readonly localPlatform?: PathPlatform;
  readonly temporaryIdFactory?: () => string;
  readonly cleanupTimeoutMs?: number;
}

const DEFAULT_SFTP_CLEANUP_TIMEOUT_MS = 5_000;

/** 在获批后建立一次性 SSH/SFTP 连接，并为单个普通文件准备安全流。 */
export class SftpTransferBackend implements TransferBackend {
  private readonly localPlatform: PathPlatform;
  private readonly cleanupTimeoutMs: number;
  public constructor(
    private readonly adapter: Pick<SshAdapter, "connect">,
    private readonly localRoots: readonly string[],
    private readonly options: SftpTransferBackendOptions = {}
  ) {
    this.localPlatform = options.localPlatform ?? (process.platform === "win32" ? "win32" : "posix");
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_SFTP_CLEANUP_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.cleanupTimeoutMs) || this.cleanupTimeoutMs <= 0) {
      throw new RangeError("SFTP 清理预算必须是正安全整数");
    }
  }

  public async prepare(request: TransferRequest, signal: AbortSignal): Promise<PreparedTransfer> {
    const resources = new ResourceClosers(this.cleanupTimeoutMs);
    let connection: SshConnection | undefined;
    let sftp: SftpTransferSession | undefined;
    let abortable: AbortableSftpConnection | undefined;
    try {
      throwIfAborted(signal);
      connection = await this.adapter.connect(request.host);
      abortable = new AbortableSftpConnection(connection, signal,
        () => Object.assign(new Error("传输已取消"), {
          code: ErrorCodes.TRANSFER_FAILED,
          cleanupOutcome: "unknown" as const
        }));
      resources.add(async () => await abortable!.close());
      throwIfAborted(signal);
      sftp = await abortable.openSftp();
      throwIfAborted(signal);
      const sourceMountVerifier = createActualConnectionMountVerifier(request, connection);
      const prepared = request.direction === "upload"
        ? await this.prepareUpload(request, connection, sftp, signal, resources, sourceMountVerifier, abortable)
        : await this.prepareDownload(request, connection, sftp, signal, resources, sourceMountVerifier, abortable);
      abortable.handoff();
      return prepared;
    } catch (error: unknown) {
      let resourceCloseFailed = false;
      try { await resources.closeAll(); } catch { resourceCloseFailed = true; }
      if (error instanceof SftpOpenedReadFileError) {
        throw new TransferPreparationError(error, "not_needed", resourceCloseFailed || error.resourceCloseFailed);
      }
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
    resources: ResourceClosers,
    sourceMountVerifier: ((source: string) => Promise<void>) | undefined,
    abortable: AbortableSftpConnection
  ): Promise<PreparedTransfer> {
    // 先证明源是普通文件，再创建任何远端临时目标；recursive=false 遇到目录必须零目标副作用拒绝。
    const local = await new LocalPathGuard(this.localRoots, { platform: this.localPlatform }).verify(request.source);
    throwIfAborted(signal);
    await sourceMountVerifier?.(request.source);
    const file = await local.openReadOnly();
    resources.add(async () => await file.close());
    const status = await file.stat();
    await sourceMountVerifier?.(request.source);
    if (!status.isFile() || !Number.isSafeInteger(status.size) || status.size! < 0 || file.createReadStream === undefined) {
      throw new PathGuardError();
    }
    if (request.expectedSourceIdentity !== undefined) {
      const identity = localOpenedIdentity(status);
      if (!sameSourceIdentity(request.expectedSourceIdentity, identity)) throw new PathGuardError();
    }
    const remote = await this.remoteGuard(request, connection, sftp, request.target);
    throwIfAborted(signal);
    const atomic = new AtomicTarget(remote.canonical, request.overwrite, request.host.platform === "linux" ? "posix" : "win32",
      new RemoteAtomicPort(sftp, remote), this.options.temporaryIdFactory);
    let target: Writable | undefined;
    try {
      target = await atomic.open();
      throwIfAborted(signal);
      const source = file.createReadStream({ autoClose: false });
      throwIfAborted(signal);
      return prepared(source, target, status.size!, atomic, resources, abortable, this.cleanupTimeoutMs);
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
    resources: ResourceClosers,
    sourceMountVerifier: ((source: string) => Promise<void>) | undefined,
    abortable: AbortableSftpConnection
  ): Promise<PreparedTransfer> {
    const remote = await this.remoteGuard(request, connection, sftp, request.source);
    throwIfAborted(signal);
    await remote.revalidateBeforeOpen();
    let sourceStatus: SftpTransferStat;
    let source: Readable;
    if (request.expectedSourceIdentity !== undefined) {
      if (sftp.openReadFile === undefined) throw new PathGuardError();
      await sourceMountVerifier?.(request.source);
      const opened = await sftp.openReadFile(remote.canonical);
      resources.add(async () => await opened.close());
      sourceStatus = opened.stat;
      source = opened.stream;
      await sourceMountVerifier?.(request.source);
      if (!sameSourceIdentity(request.expectedSourceIdentity, sourceStatus)) {
        throw new PathGuardError();
      }
    } else {
      sourceStatus = await sftp.lstat(remote.canonical);
      source = sftp.createReadStream(remote.canonical);
    }
    if (sourceStatus.kind !== "file" || !Number.isSafeInteger(sourceStatus.size) || sourceStatus.size < 0) {
      source.destroy();
      throw new PathGuardError();
    }

    const local = await new LocalPathGuard(this.localRoots, { platform: this.localPlatform }).verify(request.target);
    throwIfAborted(signal);
    const atomic = new AtomicTarget(local.canonical, request.overwrite, this.localPlatform,
      new LocalAtomicPort(local), this.options.temporaryIdFactory);
    let target: Writable | undefined;
    try {
      target = await atomic.open();
      throwIfAborted(signal);
      return prepared(source, target, sourceStatus.size, atomic, resources, abortable, this.cleanupTimeoutMs);
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
    const probe = new WindowsReparseProbe({
      execute: async (command) => await executeBoundedProbe(connection, command, MAX_WINDOWS_REPARSE_PROBE_STDOUT_BYTES)
    }, request.host.shell.command);
    return await new WindowsPathGuard(request.host.remoteRoots, sftp, probe).verify(target);
  }
}

/**
 * 递归远端下载不得复用目录枚举连接的 mount namespace。这里仅根据内部批准元数据，
 * 在即将持有真实 SFTP handle 的连接上执行固定 mountinfo 探针。
 */
function createActualConnectionMountVerifier(
  request: TransferRequest,
  connection: SshConnection
): ((source: string) => Promise<void>) | undefined {
  const proof = request.sourceMountProof;
  if (proof === undefined || request.direction !== "download" || proof.platform !== "posix") {
    return request.sourceMountVerifier;
  }
  const root = canonicalPosix(proof.sourceRoot);
  return async (candidate: string): Promise<void> => {
    const target = canonicalPosix(candidate);
    if (!isPathWithin(target, root)) throw new PathGuardError();
    const mountPoints = await loadRemoteLinuxMountPoints(connection);
    for (const mountPoint of mountPoints) {
      // 根文件系统不是源树内新增边界；其余覆盖当前访问路径的源树挂载一律拒绝。
      if (mountPoint !== "/" && isPathWithin(mountPoint, root) && isPathWithin(target, mountPoint)) {
        throw new PathGuardError();
      }
    }
  };
}

const MAX_MOUNT_INFO_BYTES = 1024 * 1024;

async function loadRemoteLinuxMountPoints(connection: SshConnection): Promise<ReadonlySet<string>> {
  const result = await executeBoundedProbe(connection, "cat -- /proc/self/mountinfo", MAX_MOUNT_INFO_BYTES);
  if (result.code !== 0 || result.stderr.length > 0) throw new PathGuardError();
  return parseLinuxMountInfo(result.stdout);
}

function parseLinuxMountInfo(content: string): ReadonlySet<string> {
  if (Buffer.byteLength(content, "utf8") > MAX_MOUNT_INFO_BYTES || content.length === 0) throw new PathGuardError();
  const result = new Set<string>();
  for (const line of content.trimEnd().split("\n")) {
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    if (separator < 6 || fields[4] === undefined) throw new PathGuardError();
    result.add(canonicalPosix(decodeMountPath(fields[4])));
  }
  if (result.size === 0) throw new PathGuardError();
  return result;
}

function decodeMountPath(value: string): string {
  if (/\\(?![0-7]{3})/.test(value)) throw new PathGuardError();
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function canonicalPosix(value: string): string {
  if (!value.startsWith("/") || value.includes("\0")) throw new PathGuardError();
  return path.posix.normalize(value);
}

function isPathWithin(candidate: string, root: string): boolean {
  return candidate === root || root === "/" || candidate.startsWith(`${root}/`);
}

function prepared(
  source: Readable,
  target: Writable,
  totalBytes: number,
  atomic: AtomicTarget,
  resources: ResourceClosers,
  abortable: AbortableSftpConnection,
  cleanupTimeoutMs: number
): PreparedTransfer {
  return {
    source, target, totalBytes,
    seal: async () => await atomic.seal(),
    commit: async () => await atomic.commit(),
    cleanup: async () => await abortable.cleanup(async () => await atomic.cleanup(), cleanupTimeoutMs),
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
  public constructor(private readonly closeTimeoutMs: number) {}
  public add(close: () => void | Promise<void>): void { this.entries.push({ closed: false, close }); }
  public async closeAll(): Promise<void> {
    const errors: unknown[] = [];
    for (const entry of [...this.entries].reverse()) {
      if (entry.closed) continue;
      entry.closed = true;
      try { await closeWithinBudget(entry.close, this.closeTimeoutMs); } catch (error: unknown) { errors.push(error); }
    }
    if (errors.length > 0) throw new AggregateError(errors, "传输资源关闭失败");
  }
}

async function closeWithinBudget(close: () => void | Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const work = Promise.resolve().then(close);
  // 超时后底层回调仍可能迟到拒绝；显式观察，不能形成 detached rejection。
  void work.catch(() => undefined);
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("传输资源关闭超时")), timeoutMs);
  });
  try { await Promise.race([work, timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
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

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === 2 || error.code === "2");
}

function localOpenedIdentity(status: { isFile(): boolean; readonly dev?: number; readonly ino?: number; readonly size?: number }): SftpTransferStat {
  if (!status.isFile() || !Number.isSafeInteger(status.dev) || status.dev! < 0
    || !Number.isSafeInteger(status.ino) || status.ino! < 0
    || !Number.isSafeInteger(status.size) || status.size! < 0) throw new PathGuardError();
  return { kind: "file", size: status.size!, id: `${status.dev!.toString(16)}:${status.ino!.toString(16)}` };
}

function sameSourceIdentity(
  expected: { readonly kind: "file"; readonly id: string; readonly size: number },
  actual: Pick<SftpTransferStat, "kind" | "id" | "size">
): boolean {
  return actual.kind === expected.kind && actual.id === expected.id && actual.size === expected.size;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw Object.assign(new Error("传输已取消"), { code: ErrorCodes.TRANSFER_FAILED });
}
