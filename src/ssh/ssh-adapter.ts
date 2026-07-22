import { stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { Client, type AuthenticationType, type ConnectConfig, type SFTPWrapper, type Stats } from "ssh2";
import type { Readable, Writable } from "node:stream";
import type { HostConfig } from "../config/schema.js";
import { ErrorCodes, type ErrorCode } from "../errors/error-codes.js";
import type { HostKeyTarget, HostKeyVerificationContext } from "./host-key.js";
import type { ApprovalRoute } from "../approval/approval-coordinator.js";
import { runPlatformProbe, type ProbeChannel, type ProbeClient } from "./platform-probe.js";

export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

export interface HostKeyVerifierPort {
  verify(target: HostKeyTarget, rawKey: Buffer, lifecycle: HostKeyVerificationContext): Promise<void>;
}

export interface SshAdapterClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

export interface SshClientLike extends ProbeClient {
  connect(config: ConnectConfig): this;
  exec(command: string, callback: (error: Error | undefined, channel: ProbeChannel) => void): this;
  exec(command: string, options: { pty: { term: string; cols: number; rows: number; width: number; height: number } }, callback: (error: Error | undefined, channel: ProbeChannel) => void): this;
  shell(
    window: { term: string; cols: number; rows: number; width: number; height: number },
    callback: (error: Error | undefined, channel: ProbeChannel) => void
  ): this;
  sftp?(callback: (error: Error | undefined, sftp: SFTPWrapper) => void): this;
  once(event: "ready", listener: () => void): this;
  on(event: "error", listener: (error: Error & { level?: string; code?: string }) => void): this;
  once(event: "close", listener: () => void): this;
  removeListener(event: string, listener: (...args: never[]) => void): this;
  end(): this;
  destroy(): this;
}

export interface SshAdapterDependencies {
  readonly createClient: () => SshClientLike;
  readonly readFile: (path: string) => Promise<Buffer>;
  readonly stat: (path: string) => Promise<{ isSocket(): boolean }>;
  readonly platform: NodeJS.Platform;
  readonly clock?: SshAdapterClock;
}

export interface SshConnection {
  exec(command: string, callback: (error: Error | undefined, channel: ProbeChannel) => void): void;
  openShell(
    columns: number,
    rows: number,
    shellCommand: string,
    callback: (error: Error | undefined, channel: ProbeChannel) => void
  ): void;
  close(): void;
  onClose?(listener: () => void): void;
  openSftp?(callback: (error: Error | undefined, sftp: SftpTransferSession) => void): void;
}

export interface SftpTransferStat {
  readonly kind: "file" | "directory" | "symlink";
  readonly id: string;
  readonly size: number;
}

export interface SftpOpenedReadFile {
  readonly stream: Readable;
  readonly stat: SftpTransferStat;
  /** 销毁流并等待底层 SFTP handle 完成一次 CLOSE。 */
  close(): Promise<void>;
}

export class SftpOpenedReadFileError extends Error {
  public readonly code = ErrorCodes.PATH_DENIED;

  public constructor(public readonly resourceCloseFailed: boolean, options?: ErrorOptions) {
    super("SFTP 已打开文件复核失败", options);
    this.name = "SftpOpenedReadFileError";
  }
}

export interface SftpTransferSession {
  lstat(path: string): Promise<SftpTransferStat>;
  realpath(path: string): Promise<string>;
  createReadStream(path: string): Readable;
  /** 以句柄打开后执行 fstat，供枚举身份连续性校验。 */
  openReadFile?(path: string): Promise<SftpOpenedReadFile>;
  createWriteStream(path: string): Writable;
  readdir?(path: string): Promise<readonly string[]>;
  mkdir?(path: string): Promise<void>;
  readonly supportsAtomicReplace: boolean;
  readonly supportsHardlink: boolean;
  atomicReplace(path: string, target: string): Promise<void>;
  hardlink(path: string, target: string): Promise<void>;
  unlink(path: string): Promise<void>;
  close(): void;
}

export class SshAdapterError extends Error {
  public constructor(
    public readonly code: ErrorCode,
    public readonly details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions
  ) {
    super(code, options);
    this.name = "SshAdapterError";
  }
}

const defaultDependencies: SshAdapterDependencies = {
  createClient: () => new Client() as unknown as SshClientLike,
  readFile: async (path) => await import("node:fs/promises").then((fileSystem) => fileSystem.readFile(path)),
  stat,
  platform: process.platform
};

const systemClock: SshAdapterClock = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout)
};

export class SshAdapter {
  private readonly activeClients = new Set<SshClientLike>();
  private shuttingDown = false;

  public constructor(
    private readonly hostKeyVerifier: HostKeyVerifierPort,
    private readonly dependencies: SshAdapterDependencies = defaultDependencies
  ) {}

  public async connect(
    host: HostConfig,
    timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    approvalRoute: ApprovalRoute = "dual"
  ): Promise<SshConnection> {
    if (this.shuttingDown) throw new SshAdapterError(ErrorCodes.CONNECTION_REFUSED);
    const authentication = await this.prepareAuthentication(host);
    if (this.shuttingDown) throw new SshAdapterError(ErrorCodes.CONNECTION_REFUSED);
    const client = this.dependencies.createClient();
    this.activeClients.add(client);
    const clock = this.dependencies.clock ?? systemClock;
    let hostKeyFailure: unknown;
    let interactiveOnly = false;
    let attempted = false;
    const authHandler = (
      methodsLeft: AuthenticationType[] | null,
      _partialSuccess: boolean | null,
      next: (method: AuthenticationType | false) => void
    ): void => {
      if (methodsLeft !== null && !methodsLeft.includes(authentication.method)) {
        interactiveOnly = methodsLeft.length > 0
          && methodsLeft.every((method) => method === "password" || method === "keyboard-interactive");
        next(false);
        return;
      }
      if (!attempted) {
        attempted = true;
        next(authentication.method);
        return;
      }
      if (methodsLeft !== null) {
        interactiveOnly = methodsLeft.length > 0
          && methodsLeft.every((method) => method === "password" || method === "keyboard-interactive");
      }
      next(false);
    };
    return await new Promise<SshConnection>((resolve, reject) => {
      let settled = false;
      let pendingFailure: unknown;
      const lifecycle = new AbortController();
      const verificationContext = lifecycle.signal as HostKeyVerificationContext;
      verificationContext.approvalRoute = approvalRoute;
      verificationContext.platform = host.platform;
      let remainingMs = timeoutMs;
      let phaseStartedAt = 0;
      let phaseTimer: unknown;
      let confirmationPaused = false;
      const clearPhaseTimer = (): void => {
        if (phaseTimer !== undefined) {
          clock.clearTimeout(phaseTimer);
          phaseTimer = undefined;
        }
      };
      const startPhaseTimer = (): boolean => {
        if (settled || remainingMs <= 0) {
          fail(new SshAdapterError(ErrorCodes.CONNECTION_TIMEOUT));
          return false;
        }
        phaseStartedAt = clock.now();
        phaseTimer = clock.setTimeout(() => fail(new SshAdapterError(ErrorCodes.CONNECTION_TIMEOUT)), remainingMs);
        return !settled && pendingFailure === undefined && !lifecycle.signal.aborted;
      };
      const pausePhaseTimer = (): boolean => {
        if (settled || pendingFailure !== undefined || lifecycle.signal.aborted) return false;
        if (phaseTimer === undefined) return remainingMs > 0;
        remainingMs = Math.max(0, remainingMs - (clock.now() - phaseStartedAt));
        clearPhaseTimer();
        if (remainingMs <= 0) {
          fail(new SshAdapterError(ErrorCodes.CONNECTION_TIMEOUT));
          return false;
        }
        confirmationPaused = true;
        return true;
      };
      const resumePhaseTimer = (): boolean => {
        if (!confirmationPaused) return !settled && pendingFailure === undefined && !lifecycle.signal.aborted;
        confirmationPaused = false;
        if (settled || pendingFailure !== undefined || lifecycle.signal.aborted) return false;
        return startPhaseTimer();
      };
      const finalizeFailure = (error: unknown): void => {
        if (settled) return;
        settled = true;
        clearPhaseTimer();
        this.activeClients.delete(client);
        client.destroy();
        reject(mapConnectionError(error, hostKeyFailure, interactiveOnly));
      };
      const fail = (error: unknown): void => {
        if (settled || pendingFailure !== undefined) return;
        pendingFailure = error;
        clearPhaseTimer();
        lifecycle.abort();
        finalizeFailure(error);
      };
      verificationContext.onConfirmationStart = pausePhaseTimer;
      verificationContext.onConfirmationEnd = resumePhaseTimer;
      const config: ConnectConfig = {
        host: host.host,
        port: host.port,
        username: host.username,
        readyTimeout: 0,
        tryKeyboard: false,
        authHandler: authHandler as ConnectConfig["authHandler"],
        hostVerifier: (rawKey: Buffer, verify: (accepted: boolean) => void): void => {
          if (settled || pendingFailure !== undefined) {
            verify(false);
            return;
          }
          const verifierPending = this.hostKeyVerifier.verify(
            { alias: host.alias, host: host.host, port: host.port },
            rawKey,
            verificationContext
          );
          void verifierPending.then(() => {
            if (settled || pendingFailure !== undefined || lifecycle.signal.aborted || remainingMs <= 0
              || !resumePhaseTimer()) {
              verify(false);
              return;
            }
            verify(true);
          }, (error: unknown) => {
            if (!lifecycle.signal.aborted && pendingFailure === undefined) {
              hostKeyFailure = error;
            }
            verify(false);
            if (!lifecycle.signal.aborted && pendingFailure === undefined) {
              fail(error);
            }
          });
        },
        ...authentication.config
      };
      client.on("error", fail);
      client.once("close", () => {
        this.activeClients.delete(client);
        fail(new Error("连接已关闭"));
      });
      client.once("ready", () => {
        void runPlatformProbe(client, host).then(() => {
          if (settled) return;
          settled = true;
          clearPhaseTimer();
          resolve({
            exec: (command, callback) => { client.exec(command, callback); },
            // 使用带 PTY 的 exec 显式启动登记 Shell，绝不退回 SSH 服务端默认登录 Shell。
            openShell: (columns, rows, shellCommand, callback) => {
              const command = host.platform === "linux"
                ? `${quotePosix(shellCommand)} -i`
                : `${quoteWindowsExecutable(shellCommand)} -NoLogo -NoProfile -NonInteractive -NoExit`;
              client.exec(command, { pty: { term: "xterm-256color", cols: columns, rows, width: 0, height: 0 } }, callback);
            },
            close: () => { client.end(); },
            onClose: (listener) => { client.once("close", listener); },
            openSftp: (callback) => {
              if (client.sftp === undefined) {
                callback(new Error("SFTP 不可用"), undefined as never);
                return;
              }
              client.sftp((error, sftp) => {
                if (error !== undefined) { callback(error, undefined as never); return; }
                callback(undefined, adaptSftp(sftp));
              });
            }
          });
        }, fail);
      });
      try {
        startPhaseTimer();
        client.connect(config);
      } catch (error: unknown) {
        fail(error);
      }
    });
  }

  /** 同步销毁所有待连接及已连接客户端；重复调用不产生新副作用。 */
  public shutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const client of [...this.activeClients]) {
      try { client.destroy(); } catch { /* 进程停止只做尽力关闭。 */ }
    }
    this.activeClients.clear();
  }

  private async prepareAuthentication(host: HostConfig): Promise<{
    readonly method: "agent" | "publickey";
    readonly config: Pick<ConnectConfig, "agent" | "privateKey">;
  }> {
    if (host.auth.type === "privateKeyFile") {
      try {
        return { method: "publickey", config: { privateKey: await this.dependencies.readFile(host.auth.path) } };
      } catch (error: unknown) {
        throw new SshAdapterError(ErrorCodes.AUTH_UNAVAILABLE, undefined, { cause: error });
      }
    }
    if (host.auth.type === "pageant") {
      if (this.dependencies.platform !== "win32") {
        throw new SshAdapterError(ErrorCodes.AUTH_UNAVAILABLE);
      }
      return { method: "agent", config: { agent: "pageant" } };
    }
    try {
      const status = await this.dependencies.stat(host.auth.socket);
      if (!status.isSocket()) {
        throw new Error("Agent 路径不是 socket");
      }
      return { method: "agent", config: { agent: host.auth.socket } };
    } catch (error: unknown) {
      throw new SshAdapterError(ErrorCodes.AUTH_UNAVAILABLE, undefined, { cause: error });
    }
  }
}

function adaptSftp(sftp: SFTPWrapper): SftpTransferSession {
  const extensions = (sftp as unknown as { _extensions?: Readonly<Record<string, string>> })._extensions ?? {};
  return {
    lstat: async (target) => await callbackValue<Stats>((callback) => sftp.lstat(target, callback)).then(toTransferStat),
    realpath: async (target) => await callbackValue<string>((callback) => sftp.realpath(target, callback)),
    createReadStream: (target) => sftp.createReadStream(target, { flags: "r", autoClose: true }),
    openReadFile: async (target) => {
      const handle = await callbackValue<Buffer>((callback) => sftp.open(target, "r", callback));
      let stream: ClosableReadStream | undefined;
      let closePromise: Promise<void> | undefined;
      const close = async (): Promise<void> => {
        closePromise ??= stream === undefined
          ? callbackVoid((callback) => sftp.close(handle, callback))
          : closeReadStream(stream);
        await closePromise;
      };
      try {
        const openedStat = await callbackValue<Stats>((callback) => sftp.fstat(handle, callback));
        const stat = toTransferStat(openedStat);
        stream = sftp.createReadStream(target, { flags: "r", handle, autoClose: false }) as ClosableReadStream;
        return {
          stream,
          stat,
          close
        };
      } catch (error: unknown) {
        try { await close(); }
        catch (closeError: unknown) {
          throw new SftpOpenedReadFileError(true, { cause: new AggregateError([error, closeError]) });
        }
        throw new SftpOpenedReadFileError(false, { cause: error });
      }
    },
    createWriteStream: (target) => sftp.createWriteStream(target, { flags: "wx", autoClose: true }),
    readdir: async (target) => await callbackValue<readonly { filename: string }[]>((callback) => sftp.readdir(target, callback as never))
      .then((entries) => entries.map((entry) => entry.filename)),
    mkdir: async (target) => await callbackVoid((callback) => sftp.mkdir(target, callback)),
    supportsAtomicReplace: extensions["posix-rename@openssh.com"] === "1",
    supportsHardlink: extensions["hardlink@openssh.com"] === "1",
    atomicReplace: async (source, target) => await callbackVoid((callback) => sftp.ext_openssh_rename(source, target, callback)),
    hardlink: async (source, target) => await callbackVoid((callback) => sftp.ext_openssh_hardlink(source, target, callback)),
    unlink: async (target) => await callbackVoid((callback) => sftp.unlink(target, callback)),
    close: () => { sftp.end(); }
  };
}

interface ClosableReadStream extends Readable {
  close(callback: (error?: Error | null) => void): void;
}

async function closeReadStream(stream: ClosableReadStream): Promise<void> {
  // ssh2 ReadStream.close() 内部完成且仅完成一次 handle CLOSE；destroy 后重复调用也只等待既有销毁边界。
  stream.on("error", ignoreLateStreamError);
  await new Promise<void>((resolve, reject) => {
    stream.close((error) => error == null ? resolve() : reject(error));
  });
}

function ignoreLateStreamError(): void { /* 句柄关闭后的迟到错误不再改变既有关闭证据。 */ }

function toTransferStat(status: Stats): SftpTransferStat {
  const kind = status.isSymbolicLink() ? "symlink" : status.isFile() ? "file" : status.isDirectory() ? "directory" : undefined;
  if (kind === undefined || !Number.isSafeInteger(status.size) || status.size < 0) throw new Error("SFTP 状态不可靠");
  const values = [status.mode, status.uid, status.gid, status.size, status.mtime];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error("SFTP 身份不可靠");
  return { kind, size: status.size, id: values.map((value) => value.toString(16)).join(":") };
}

async function callbackValue<T>(invoke: (callback: (error: Error | undefined, value: T) => void) => void): Promise<T> {
  return await new Promise<T>((resolve, reject) => invoke((error, value) => error === undefined ? resolve(value) : reject(error)));
}
async function callbackVoid(invoke: (callback: (error?: Error | null) => void) => void): Promise<void> {
  await new Promise<void>((resolve, reject) => invoke((error) => error == null ? resolve() : reject(error)));
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `"'"'`)}'`;
}

function quoteWindowsExecutable(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function mapConnectionError(error: unknown, hostKeyFailure: unknown, interactiveOnly: boolean): SshAdapterError | Error {
  if (hasStableCode(hostKeyFailure)) {
    return hostKeyFailure;
  }
  if (hasStableCode(error)) {
    return error;
  }
  if (interactiveOnly) {
    return new SshAdapterError(ErrorCodes.INTERACTIVE_AUTH_UNSUPPORTED);
  }
  if (isSshError(error) && (error.level === "client-timeout" || error.code === "ETIMEDOUT")) {
    return new SshAdapterError(ErrorCodes.CONNECTION_TIMEOUT);
  }
  if (isSshError(error) && error.code === "ECONNREFUSED") {
    return new SshAdapterError(ErrorCodes.CONNECTION_REFUSED);
  }
  if (isSshError(error) && error.level === "agent") {
    return new SshAdapterError(ErrorCodes.AUTH_UNAVAILABLE);
  }
  if (isSshError(error) && /encrypted|passphrase/i.test(error.message)) {
    return new SshAdapterError(ErrorCodes.AUTH_UNAVAILABLE);
  }
  if (isSshError(error) && error.level === "client-authentication") {
    return new SshAdapterError(ErrorCodes.AUTH_FAILED);
  }
  return new SshAdapterError(ErrorCodes.AUTH_FAILED);
}

function hasStableCode(value: unknown): value is SshAdapterError {
  return value instanceof Error && "code" in value && typeof value.code === "string"
    && Object.values(ErrorCodes).includes(value.code as ErrorCode);
}

function isSshError(value: unknown): value is Error & { level?: string; code?: string } {
  return value instanceof Error;
}
