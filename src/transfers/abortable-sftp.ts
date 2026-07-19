import type { SftpTransferSession, SshConnection } from "../ssh/ssh-adapter.js";

/** 将完整 Prepared 生命周期内的远端 Promise 与取消信号竞速，并保证资源只关闭一次。 */
export class AbortableSftpConnection {
  private readonly abortPromise: Promise<never>;
  private rejectAbort!: (error: Error) => void;
  private sftp: SftpTransferSession | undefined;
  private connectionClosed = false;
  private sftpClosed = false;
  private aborted = false;
  private closeOnAbort = true;
  private cleanupDepth = 0;

  public constructor(
    private readonly connection: SshConnection,
    private readonly signal: AbortSignal,
    private readonly abortError: () => Error
  ) {
    this.abortPromise = new Promise<never>((_resolve, reject) => { this.rejectAbort = reject; });
    void this.abortPromise.catch(() => undefined);
    this.signal.addEventListener("abort", this.onAbort, { once: true });
    if (this.signal.aborted) this.onAbort();
  }

  public async openSftp(): Promise<SftpTransferSession> {
    if (this.connection.openSftp === undefined) throw this.abortError();
    const pending = new Promise<SftpTransferSession>((resolve, reject) => {
      this.connection.openSftp!((error, sftp) => error === undefined ? resolve(sftp) : reject(error));
    });
    void pending.then((sftp) => {
      if (!this.aborted) return;
      try { sftp.close(); } catch { /* 迟到资源只做尽力关闭。 */ }
    }, () => undefined);
    const sftp = await this.race(async () => await pending);
    this.sftp = sftp;
    return this.wrap(sftp);
  }

  public async close(): Promise<void> {
    this.signal.removeEventListener("abort", this.onAbort);
    this.closeSftp();
    this.closeConnection();
  }

  /** 交接后仍中止挂起 Promise，但资源关闭顺序改由执行器负责。 */
  public handoff(): void {
    this.closeOnAbort = false;
  }

  /** cleanup 由执行器持有独立预算；其间不复用已拒绝的业务 abort。 */
  public async cleanup<T>(work: () => Promise<T>, timeoutMs: number): Promise<T> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError("SFTP 清理预算必须是正安全整数");
    let timer: NodeJS.Timeout | undefined;
    this.cleanupDepth += 1;
    try {
      const cleanupWork = Promise.resolve().then(work);
      // 预算耗尽后底层清理仍可能迟到拒绝；显式观察，不能形成 detached rejection。
      void cleanupWork.catch(() => undefined);
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("SFTP 清理超时"), {
          cleanupOutcome: "unknown" as const
        })), timeoutMs);
      });
      return await Promise.race([cleanupWork, timeout]);
    } finally {
      this.cleanupDepth -= 1;
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private readonly onAbort = (): void => {
    if (this.aborted) return;
    this.aborted = true;
    const error = this.abortError();
    if (this.closeOnAbort) {
      this.closeSftp();
      this.closeConnection();
    }
    this.rejectAbort(error);
  };

  private async race<T>(work: () => Promise<T>): Promise<T> {
    if (this.cleanupDepth > 0) return await work();
    if (this.aborted || this.signal.aborted) throw this.abortError();
    return await Promise.race([work(), this.abortPromise]);
  }

  private wrap(sftp: SftpTransferSession): SftpTransferSession {
    const race = async <T>(work: () => Promise<T>): Promise<T> => await this.race(work);
    return {
      lstat: async (path) => await race(async () => await sftp.lstat(path)),
      realpath: async (path) => await race(async () => await sftp.realpath(path)),
      createReadStream: (path) => { this.throwIfAborted(); return sftp.createReadStream(path); },
      ...(sftp.openReadFile === undefined ? {} : { openReadFile: async (path: string) => await race(async () => await sftp.openReadFile!(path)) }),
      createWriteStream: (path) => { this.throwIfAborted(); return sftp.createWriteStream(path); },
      ...(sftp.readdir === undefined ? {} : { readdir: async (path: string) => await race(async () => await sftp.readdir!(path)) }),
      ...(sftp.mkdir === undefined ? {} : { mkdir: async (path: string) => await race(async () => await sftp.mkdir!(path)) }),
      supportsAtomicReplace: sftp.supportsAtomicReplace,
      supportsHardlink: sftp.supportsHardlink,
      atomicReplace: async (path, target) => await race(async () => await sftp.atomicReplace(path, target)),
      hardlink: async (path, target) => await race(async () => await sftp.hardlink(path, target)),
      unlink: async (path) => await race(async () => await sftp.unlink(path)),
      close: () => this.closeSftp()
    };
  }

  private throwIfAborted(): void {
    if (this.aborted || this.signal.aborted) throw this.abortError();
  }

  private closeSftp(): void {
    if (this.sftpClosed || this.sftp === undefined) return;
    this.sftpClosed = true;
    try { this.sftp.close(); } catch { /* 关闭结果由上层保守终态处理。 */ }
  }

  private closeConnection(): void {
    if (this.connectionClosed) return;
    this.connectionClosed = true;
    try { this.connection.close(); } catch { /* 关闭结果由上层保守终态处理。 */ }
  }
}
