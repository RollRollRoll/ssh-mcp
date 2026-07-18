import { stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { Client, type AuthenticationType, type ConnectConfig, type SFTPWrapper, type Stats } from "ssh2";
import type { Readable, Writable } from "node:stream";
import type { HostConfig } from "../config/schema.js";
import { ErrorCodes, type ErrorCode } from "../errors/error-codes.js";
import type { HostKeyTarget, HostKeyVerificationContext } from "./host-key.js";
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

export interface SftpTransferSession {
  lstat(path: string): Promise<SftpTransferStat>;
  realpath(path: string): Promise<string>;
  createReadStream(path: string): Readable;
  createWriteStream(path: string): Writable;
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
  public constructor(
    private readonly hostKeyVerifier: HostKeyVerifierPort,
    private readonly dependencies: SshAdapterDependencies = defaultDependencies
  ) {}

  public async connect(host: HostConfig, timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS): Promise<SshConnection> {
    const authentication = await this.prepareAuthentication(host);
    const client = this.dependencies.createClient();
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
      client.once("close", () => fail(new Error("连接已关闭")));
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
    createWriteStream: (target) => sftp.createWriteStream(target, { flags: "wx", autoClose: true }),
    supportsAtomicReplace: extensions["posix-rename@openssh.com"] === "1",
    supportsHardlink: extensions["hardlink@openssh.com"] === "1",
    atomicReplace: async (source, target) => await callbackVoid((callback) => sftp.ext_openssh_rename(source, target, callback)),
    hardlink: async (source, target) => await callbackVoid((callback) => sftp.ext_openssh_hardlink(source, target, callback)),
    unlink: async (target) => await callbackVoid((callback) => sftp.unlink(target, callback)),
    close: () => { sftp.end(); }
  };
}

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
