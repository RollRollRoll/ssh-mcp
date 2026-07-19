import path from "node:path";
import { execFile } from "node:child_process";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import type { Stats } from "node:fs";
import { promisify } from "node:util";
import { ErrorCodes } from "../errors/error-codes.js";
import { LocalPathGuard } from "../paths/local-path-guard.js";
import { LinuxPathGuard, type RemoteSafePathHandle } from "../paths/linux-path-guard.js";
import { lexicalPathHandle, PathGuardError, type PathPlatform } from "../paths/path-guard.js";
import { WindowsPathGuard } from "../paths/windows-path-guard.js";
import { MAX_WINDOWS_REPARSE_PROBE_STDOUT_BYTES, WindowsReparseProbe } from "../paths/windows-reparse-probe.js";
import { executeBoundedProbe } from "../ssh/bounded-probe.js";
import type { SftpTransferSession, SshAdapter, SshConnection } from "../ssh/ssh-adapter.js";
import { DirectoryWalker, type DirectoryWalkEntry, type DirectoryWalkPort, type DirectoryWalkStat, validateRelativePath } from "./directory-walker.js";
import {
  DirectoryTransferSetupError,
  type DirectoryTransferBackend,
  type PreparedDirectoryTransfer
} from "./directory-transfer.js";
import type { TransferRequest } from "./file-transfer.js";
import { SftpTransferBackend } from "./sftp-transfer-backend.js";
import { AbortableSftpConnection } from "./abortable-sftp.js";

export interface SftpDirectoryTransferBackendOptions {
  readonly localPlatform?: PathPlatform;
  readonly temporaryIdFactory?: () => string;
}

/** 获批后安全枚举目录；普通文件委托 Task 10 后端执行原子流式传输。 */
export class SftpDirectoryTransferBackend implements DirectoryTransferBackend {
  private readonly localPlatform: PathPlatform;
  private readonly singleFile: SftpTransferBackend;

  public constructor(
    private readonly adapter: Pick<SshAdapter, "connect">,
    private readonly localRoots: readonly string[],
    private readonly options: SftpDirectoryTransferBackendOptions = {}
  ) {
    this.localPlatform = options.localPlatform ?? (process.platform === "win32" ? "win32" : "posix");
    this.singleFile = new SftpTransferBackend(adapter, localRoots, options);
  }

  public async prepare(request: TransferRequest, signal: AbortSignal): Promise<PreparedDirectoryTransfer> {
    if (!request.recursive) throw new DirectoryTransferSetupError(ErrorCodes.INVALID_ARGUMENT);
    throwIfAborted(signal);
    const connection = await this.adapter.connect(request.host);
    const abortable = new AbortableSftpConnection(connection, signal,
      () => new DirectoryTransferSetupError(ErrorCodes.TRANSFER_FAILED));
    let sftp: SftpTransferSession | undefined;
    try {
      sftp = await abortable.openSftp();
      if (sftp.readdir === undefined || sftp.mkdir === undefined) throw new DirectoryTransferSetupError(ErrorCodes.TRANSFER_FAILED);
      const sourcePlatform = request.direction === "upload" ? this.localPlatform : remotePlatform(request);
      const targetPlatform = request.direction === "upload" ? remotePlatform(request) : this.localPlatform;
      const sourceRoot = joinChecked(request.source, "", sourcePlatform);
      const sourceMountVerifier = createSourceMountVerifier(
        sourceRoot,
        sourcePlatform,
        sourcePlatform === "posix"
          ? request.direction === "upload"
            ? loadLocalMountPoints
            : async () => await loadRemoteLinuxMountPoints(connection)
          : emptyMountPoints
      );
      const sourcePort = request.direction === "upload"
        ? localWalkPort(this.localRoots, this.localPlatform, sourceMountVerifier)
        : remoteWalkPort(request, connection, sftp, sourceMountVerifier);
      const sourceIdentity = await sourcePort.inspect(sourceRoot);
      if (sourceIdentity.kind !== "directory") throw new DirectoryTransferSetupError(ErrorCodes.PATH_DENIED);
      await assertTargetAbsent(request, connection, sftp, this.localRoots, this.localPlatform, request.target);
      const entries = await new DirectoryWalker(sourcePort, sourcePlatform).walk(sourceRoot);
      const sourceAfterWalk = await sourcePort.inspect(sourceRoot);
      if (!sameStat(sourceIdentity, sourceAfterWalk)) throw new DirectoryTransferSetupError(ErrorCodes.PATH_DENIED);
      throwIfAborted(signal);
      abortable.disarm();
      return Object.freeze({
        entries,
        createTargetRoot: async () => {
          await assertSameSource(sourcePort, sourceRoot, sourceIdentity);
          await createTargetDirectory(request, connection, sftp!, this.localRoots, this.localPlatform, request.target);
        },
        createDirectory: async (entry: DirectoryWalkEntry) => {
          await assertSourceEntry(sourcePort, request.source, sourcePlatform, entry);
          const target = joinChecked(request.target, entry.relativePath, targetPlatform);
          await createTargetDirectory(request, connection, sftp!, this.localRoots, this.localPlatform, target);
        },
        prepareFile: async (entry: DirectoryWalkEntry, itemSignal: AbortSignal) => {
          await assertSourceEntry(sourcePort, request.source, sourcePlatform, entry);
          const source = joinChecked(request.source, entry.relativePath, sourcePlatform);
          const target = joinChecked(request.target, entry.relativePath, targetPlatform);
          return await this.singleFile.prepare({
            ...request, source, target, overwrite: false, recursive: false,
            expectedSourceIdentity: { kind: "file", id: entry.id, size: entry.size },
            // 远端下载由逐文件后端在实际打开 SFTP handle 的连接上重新取证；不得跨连接传递闭包。
            sourceMountVerifier: request.direction === "upload"
              ? async (candidate) => await sourceMountVerifier.verify(candidate)
              : undefined,
            sourceMountProof: { sourceRoot, platform: sourcePlatform }
          }, itemSignal);
        },
        close: async () => { await abortable.close(); }
      });
    } catch (error: unknown) {
      await abortable.close();
      throw normalizeSetupError(error);
    }
  }
}

function localWalkPort(roots: readonly string[], platform: PathPlatform, mountVerifier: SourceMountVerifier): DirectoryWalkPort {
  const guard = new LocalPathGuard(roots, { platform });
  const inspect = async (target: string): Promise<DirectoryWalkStat> => {
    const safe = await guard.verify(target);
    const canonicalMountPath = platform === "posix" ? canonicalPosix(safe.canonical) : undefined;
    const status = await mountVerifier.withFresh(target, async () => {
      await safe.revalidateBeforeOpen();
      let current: Stats;
      try { current = await lstat(safe.canonical); } catch { throw new PathGuardError(); }
      await safe.revalidateBeforeOpen();
      return current;
    });
    const result = localStat(status, false);
    if (result.mountPoint !== false) throw new PathGuardError();
    return result;
  };
  return {
    inspect,
    list: async (target) => {
      const safe = await guard.verify(target);
      return await mountVerifier.withFresh(target, async () => {
        await safe.revalidateBeforeOpen();
        const before = localStat(await lstat(safe.canonical), false);
        if (before.kind !== "directory") throw new PathGuardError();
        const names = await readdir(safe.canonical);
        await safe.revalidateBeforeOpen();
        const after = localStat(await lstat(safe.canonical), false);
        if (!sameStat(before, after)) throw new PathGuardError();
        return names;
      });
    }
  };
}

function remoteWalkPort(
  request: TransferRequest,
  connection: SshConnection,
  sftp: SftpTransferSession,
  mountVerifier: SourceMountVerifier
): DirectoryWalkPort {
  const inspect = async (target: string): Promise<DirectoryWalkStat> => {
    const safe = await remoteGuard(request, connection, sftp, target);
    const status = await mountVerifier.withFresh(target, async () => {
      await safe.revalidateBeforeOpen();
      const current = await sftp.lstat(safe.canonical);
      await safe.revalidateBeforeOpen();
      return current;
    });
    if (status.kind === "symlink") throw new PathGuardError(ErrorCodes.LINK_NOT_ALLOWED);
    if (status.kind !== "file" && status.kind !== "directory") throw new PathGuardError();
    const result = {
      kind: status.kind, size: checkedSize(status.size), id: status.id,
      mountPoint: false
    } as const;
    if (result.mountPoint !== false) throw new PathGuardError();
    return result;
  };
  return {
    inspect,
    list: async (target) => {
      if (sftp.readdir === undefined) throw new DirectoryTransferSetupError(ErrorCodes.TRANSFER_FAILED);
      const safe = await remoteGuard(request, connection, sftp, target);
      return await mountVerifier.withFresh(target, async () => {
        await safe.revalidateBeforeOpen();
        const beforeStatus = await sftp.lstat(safe.canonical);
        if (beforeStatus.kind !== "directory") throw beforeStatus.kind === "symlink" ? new PathGuardError(ErrorCodes.LINK_NOT_ALLOWED) : new PathGuardError();
        const before = { kind: beforeStatus.kind, size: checkedSize(beforeStatus.size), id: beforeStatus.id } as const;
        const names = await sftp.readdir!(safe.canonical);
        await safe.revalidateBeforeOpen();
        const afterStatus = await sftp.lstat(safe.canonical);
        const after = { kind: afterStatus.kind, size: checkedSize(afterStatus.size), id: afterStatus.id } as const;
        if (!sameStat(before, after)) throw new PathGuardError();
        return names;
      });
    }
  };
}

async function assertTargetAbsent(
  request: TransferRequest,
  connection: SshConnection,
  sftp: SftpTransferSession,
  localRoots: readonly string[],
  localPlatform: PathPlatform,
  target: string
): Promise<void> {
  if (request.direction === "upload") {
    const safe = await remoteGuard(request, connection, sftp, target);
    await safe.revalidateBeforeOpen();
    try { await sftp.lstat(safe.canonical); throw new DirectoryTransferSetupError(ErrorCodes.TARGET_EXISTS); }
    catch (error: unknown) { if (!isNotFound(error)) throw error; }
    return;
  }
  const safe = await new LocalPathGuard(localRoots, { platform: localPlatform }).verify(target);
  await safe.revalidateBeforeOpen();
  try { await lstat(safe.canonical); throw new DirectoryTransferSetupError(ErrorCodes.TARGET_EXISTS); }
  catch (error: unknown) { if (!isNotFound(error)) throw error; }
}

async function createTargetDirectory(
  request: TransferRequest,
  connection: SshConnection,
  sftp: SftpTransferSession,
  localRoots: readonly string[],
  localPlatform: PathPlatform,
  target: string
): Promise<void> {
  await assertTargetAbsent(request, connection, sftp, localRoots, localPlatform, target);
  try {
    if (request.direction === "upload") {
      if (sftp.mkdir === undefined) throw new DirectoryTransferSetupError(ErrorCodes.TRANSFER_FAILED);
      const safe = await remoteGuard(request, connection, sftp, target);
      await safe.revalidateBeforeOpen();
      await sftp.mkdir(safe.canonical);
    } else {
      const safe = await new LocalPathGuard(localRoots, { platform: localPlatform }).verify(target);
      await safe.revalidateBeforeOpen();
      await mkdir(safe.canonical);
    }
  } catch (error: unknown) {
    if (isExists(error)) throw new DirectoryTransferSetupError(ErrorCodes.TARGET_EXISTS);
    throw Object.assign(error instanceof Error ? error : new Error("目标目录创建结果未知"), { targetCreation: "unknown" as const });
  }
}

async function assertSourceEntry(port: DirectoryWalkPort, root: string, platform: PathPlatform, entry: DirectoryWalkEntry): Promise<void> {
  const actual = await port.inspect(joinChecked(root, entry.relativePath, platform));
  if (!sameStat(entry, actual)) throw new PathGuardError();
}
async function assertSameSource(port: DirectoryWalkPort, path: string, expected: DirectoryWalkStat): Promise<void> {
  if (!sameStat(expected, await port.inspect(path))) throw new PathGuardError();
}

function joinChecked(root: string, relative: string, platform: PathPlatform): string {
  const library = platform === "posix" ? path.posix : path.win32;
  if (relative === "") return lexicalPathHandle(root, [root], platform).canonical;
  validateRelativePath(relative);
  return lexicalPathHandle(library.join(root, ...relative.split("/")), [root], platform).canonical;
}

async function remoteGuard(request: TransferRequest, connection: SshConnection, sftp: SftpTransferSession, target: string): Promise<RemoteSafePathHandle> {
  if (request.host.platform === "linux") return await new LinuxPathGuard(request.host.remoteRoots, sftp).verify(target);
  const probe = new WindowsReparseProbe({
    execute: async (command) => await executeBoundedProbe(connection, command, MAX_WINDOWS_REPARSE_PROBE_STDOUT_BYTES)
  }, request.host.shell.command);
  return await new WindowsPathGuard(request.host.remoteRoots, sftp, probe).verify(target);
}

function localStat(status: Stats, mountPoint: boolean): DirectoryWalkStat {
  if (status.isSymbolicLink()) return { kind: "symlink", size: 0, id: "link", mountPoint };
  const kind = status.isFile() ? "file" : status.isDirectory() ? "directory" : "unknown";
  if (!Number.isSafeInteger(status.dev) || status.dev < 0 || !Number.isSafeInteger(status.ino) || status.ino < 0) throw new PathGuardError();
  return { kind, size: checkedSize(status.size), id: `${status.dev.toString(16)}:${status.ino.toString(16)}`, mountPoint };
}
function checkedSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new PathGuardError();
  return value;
}
function sameStat(left: Pick<DirectoryWalkStat, "kind" | "size" | "id">, right: Pick<DirectoryWalkStat, "kind" | "size" | "id">): boolean {
  return left.kind === right.kind && left.size === right.size && left.id === right.id;
}
function remotePlatform(request: TransferRequest): PathPlatform { return request.host.platform === "linux" ? "posix" : "win32"; }
function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw new DirectoryTransferSetupError(ErrorCodes.TRANSFER_FAILED); }
function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === 2 || error.code === "2");
}
function isExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "EEXIST" || error.code === 4 || error.code === "4");
}
function normalizeSetupError(error: unknown): unknown {
  if (error instanceof DirectoryTransferSetupError || error instanceof PathGuardError) return error;
  if (isExists(error)) return new DirectoryTransferSetupError(ErrorCodes.TARGET_EXISTS);
  return error;
}

const executeFile = promisify(execFile);
const MAX_MOUNT_INFO_BYTES = 1024 * 1024;

async function loadLocalMountPoints(): Promise<ReadonlySet<string>> {
  if (process.platform === "linux") {
    let content: string;
    try { content = await readUtf8Bounded("/proc/self/mountinfo", MAX_MOUNT_INFO_BYTES); }
    catch { throw new PathGuardError(); }
    return parseLinuxMountInfo(content);
  }
  if (process.platform === "darwin") {
    try {
      const { stdout } = await executeFile("/sbin/mount", [], { maxBuffer: MAX_MOUNT_INFO_BYTES, encoding: "utf8" });
      return parseDarwinMountInfo(stdout);
    } catch { throw new PathGuardError(); }
  }
  throw new PathGuardError();
}

async function loadRemoteLinuxMountPoints(connection: SshConnection): Promise<ReadonlySet<string>> {
  const result = await executeBoundedProbe(connection, "cat -- /proc/self/mountinfo", MAX_MOUNT_INFO_BYTES);
  if (result.code !== 0 || result.stderr.length > 0) {
    throw new PathGuardError();
  }
  return parseLinuxMountInfo(result.stdout);
}

export async function withFreshMountEvidence<T>(
  load: () => Promise<ReadonlySet<string>>,
  access: (mountPoints: ReadonlySet<string>) => Promise<T>
): Promise<{ readonly value: T; readonly mountPoints: ReadonlySet<string> }> {
  const before = await load();
  const value = await access(before);
  const after = await load();
  if (!sameMountPoints(before, after)) throw new PathGuardError();
  return Object.freeze({ value, mountPoints: after });
}

export interface SourceMountVerifier {
  verify(target: string): Promise<void>;
  withFresh<T>(target: string, access: () => Promise<T>): Promise<T>;
}

/** 源树挂载证明：每次访问前后都重新取证，并拒绝源根范围内覆盖当前路径的挂载。 */
export function createSourceMountVerifier(
  sourceRoot: string,
  platform: PathPlatform,
  load: () => Promise<ReadonlySet<string>>
): SourceMountVerifier {
  if (platform === "win32") {
    return Object.freeze({
      verify: async () => undefined,
      withFresh: async <T>(_target: string, access: () => Promise<T>) => await access()
    });
  }
  const root = canonicalPosix(sourceRoot);
  const assertSafe = (target: string, mountPoints: ReadonlySet<string>): void => {
    const candidate = canonicalPosix(target);
    if (!isPathWithin(candidate, root)) throw new PathGuardError();
    for (const mountPoint of mountPoints) {
      // 全局根文件系统是所有绝对路径的祖先，不是源树中新引入的挂载边界。
      if (mountPoint === "/") continue;
      if (isPathWithin(mountPoint, root) && isPathWithin(candidate, mountPoint)) throw new PathGuardError();
    }
  };
  const verify = async (target: string): Promise<void> => { assertSafe(target, await load()); };
  return Object.freeze({
    verify,
    withFresh: async <T>(target: string, access: () => Promise<T>): Promise<T> => {
      const before = await load();
      assertSafe(target, before);
      const value = await access();
      const after = await load();
      assertSafe(target, after);
      if (!sameMountPoints(before, after)) throw new PathGuardError();
      return value;
    }
  });
}

async function emptyMountPoints(): Promise<ReadonlySet<string>> { return new Set(); }

function sameMountPoints(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

function isPathWithin(candidate: string, root: string): boolean {
  return candidate === root || root === "/" || candidate.startsWith(`${root}/`);
}

async function readUtf8Bounded(target: string, maxBytes: number): Promise<string> {
  const handle = await open(target, "r");
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total <= maxBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) return Buffer.concat(chunks, total).toString("utf8");
      total += bytesRead;
      if (total > maxBytes) throw new PathGuardError();
      chunks.push(buffer.subarray(0, bytesRead));
    }
    throw new PathGuardError();
  } finally {
    await handle.close();
  }
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

function parseDarwinMountInfo(content: string): ReadonlySet<string> {
  if (Buffer.byteLength(content, "utf8") > MAX_MOUNT_INFO_BYTES || content.length === 0) throw new PathGuardError();
  const result = new Set<string>();
  for (const line of content.trimEnd().split("\n")) {
    const match = / on (.+) \([^)]*\)$/.exec(line);
    if (match?.[1] === undefined) throw new PathGuardError();
    result.add(canonicalPosix(decodeMountPath(match[1])));
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
