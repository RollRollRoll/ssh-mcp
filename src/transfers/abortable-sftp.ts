import type { SftpTransferSession, SshConnection } from "../ssh/ssh-adapter.js";

/** 将 prepare 阶段远端 Promise 与取消信号竞速，并保证 SFTP/连接各关闭一次。 */
export class AbortableSftpConnection {
  private readonly abortPromise: Promise<never>;
  private rejectAbort!: (error: Error) => void;
  private sftp: SftpTransferSession | undefined;
  private connectionClosed = false;
  private sftpClosed = false;
  private aborted = false;
  private armed = true;

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
    const sftp = await this.race(pending);
    this.sftp = sftp;
    return this.wrap(sftp);
  }

  public async close(): Promise<void> {
    this.signal.removeEventListener("abort", this.onAbort);
    this.closeSftp();
    this.closeConnection();
  }

  /** PreparedTransfer 已交给执行器后，由执行器按“先清理临时目标、再关闭资源”的顺序接管取消。 */
  public disarm(): void {
    this.armed = false;
    this.signal.removeEventListener("abort", this.onAbort);
  }

  private readonly onAbort = (): void => {
    if (!this.armed || this.aborted) return;
    this.aborted = true;
    const error = this.abortError();
    this.closeSftp();
    this.closeConnection();
    this.rejectAbort(error);
  };

  private async race<T>(work: Promise<T>): Promise<T> {
    if (!this.armed) return await work;
    if (this.aborted || this.signal.aborted) throw this.abortError();
    return await Promise.race([work, this.abortPromise]);
  }

  private wrap(sftp: SftpTransferSession): SftpTransferSession {
    const race = async <T>(work: Promise<T>): Promise<T> => await this.race(work);
    return {
      lstat: async (path) => await race(sftp.lstat(path)),
      realpath: async (path) => await race(sftp.realpath(path)),
      createReadStream: (path) => { this.throwIfAborted(); return sftp.createReadStream(path); },
      ...(sftp.openReadFile === undefined ? {} : { openReadFile: async (path: string) => await race(sftp.openReadFile!(path)) }),
      createWriteStream: (path) => { this.throwIfAborted(); return sftp.createWriteStream(path); },
      ...(sftp.readdir === undefined ? {} : { readdir: async (path: string) => await race(sftp.readdir!(path)) }),
      ...(sftp.mkdir === undefined ? {} : { mkdir: async (path: string) => await race(sftp.mkdir!(path)) }),
      supportsAtomicReplace: sftp.supportsAtomicReplace,
      supportsHardlink: sftp.supportsHardlink,
      atomicReplace: async (path, target) => await race(sftp.atomicReplace(path, target)),
      hardlink: async (path, target) => await race(sftp.hardlink(path, target)),
      unlink: async (path) => await race(sftp.unlink(path)),
      close: () => this.closeSftp()
    };
  }

  private throwIfAborted(): void {
    if (this.armed && (this.aborted || this.signal.aborted)) throw this.abortError();
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
