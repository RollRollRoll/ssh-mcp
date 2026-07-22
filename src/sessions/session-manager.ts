import { randomUUID } from "node:crypto";
import { createMcpOperationError, type McpOperationError } from "../errors/error-contract.js";
import { ErrorCodes } from "../errors/error-codes.js";
import {
  DEFAULT_OUTPUT_READ_BYTES,
  DEFAULT_OUTPUT_BUFFER_BYTES,
  MAX_OUTPUT_READ_BYTES,
  OutputBuffer,
  OutputBufferError,
  type OutputFrame,
  type OutputReadResult
} from "../operations/output-buffer.js";
import { SessionInputQueue } from "./session-input-queue.js";

export type SessionState = "opening" | "active" | "closing" | "closed" | "disconnected" | "unknown";

export interface SessionClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

export interface SessionChannel {
  readonly stderr?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  write(data: Buffer, callback?: (error?: Error | null) => void): boolean | void;
  setWindow(rows: number, columns: number, height: number, width: number): void;
  close(): void;
  once(event: "error" | "close" | "drain", listener: (...args: readonly unknown[]) => void): this;
  removeListener(event: "error" | "close" | "drain", listener: (...args: readonly unknown[]) => void): this;
  on(event: "data", listener: (chunk: Buffer | string) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: (...args: readonly unknown[]) => void): this;
  on(event: "exit", listener: (...args: readonly unknown[]) => void): this;
}

export interface SessionConnection { close(): void; }

export interface SessionSnapshot {
  readonly sessionId: string;
  readonly host: string;
  readonly platform: "linux" | "windows";
  readonly shell: "posix" | "powershell";
  readonly state: SessionState;
  readonly columns: number;
  readonly rows: number;
}

export interface SessionOutputFrame extends OutputFrame {
  readonly seq: number;
  readonly byteLength: number;
}

export interface SessionGetResult extends SessionSnapshot, Omit<OutputReadResult, "frames"> {
  readonly frames: readonly SessionOutputFrame[];
}

export class SessionManagerError extends Error {
  public constructor(readonly error: McpOperationError, readonly session?: SessionSnapshot) {
    super(error.message);
    this.name = "SessionManagerError";
  }
}

export interface SessionManagerOptions {
  readonly clock?: SessionClock;
  readonly idFactory?: () => string;
  readonly outputBufferBytes?: number;
  readonly maxSessions?: number;
  readonly idleTimeoutMs?: number;
  readonly closeConfirmationTimeoutMs?: number;
  readonly retentionMs?: number;
  readonly onStateChange?: (snapshot: SessionSnapshot) => void;
}

interface SessionRecord {
  readonly id: string;
  readonly host: string;
  readonly platform: "linux" | "windows";
  readonly shell: "posix" | "powershell";
  readonly output: OutputBuffer;
  readonly queue: SessionInputQueue;
  state: SessionState;
  columns: number;
  rows: number;
  channel: SessionChannel | undefined;
  connection: SessionConnection | undefined;
  closeRequested: boolean;
  channelCloseRequested: boolean;
  forced: boolean;
  idleTimer: unknown;
  closeTimer: unknown;
  retentionTimer: unknown;
  nextFrameSeq: number;
  resourcesClosed: boolean;
  readonly pendingWriteTerminations: Set<() => void>;
}

const systemClock: SessionClock = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout)
};
const MAX_SESSION_RECORDS = 40;
const MAX_EXPIRED_SESSION_IDS = 40;

/** 进程内 PTY 会话生命周期；不做重连、恢复、重放或共享连接。 */
export class SessionManager {
  private readonly records = new Map<string, SessionRecord>();
  private readonly expired = new Set<string>();
  private readonly clock: SessionClock;
  private readonly idFactory: () => string;
  private readonly outputBufferBytes: number;
  private readonly maxSessions: number;
  private readonly idleTimeoutMs: number;
  private readonly closeConfirmationTimeoutMs: number;
  private readonly retentionMs: number;
  private readonly onStateChange: ((snapshot: SessionSnapshot) => void) | undefined;
  private readonly subscribers = new Set<() => void>();
  private readonly shutdownWaiters = new Set<() => void>();
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | undefined;

  public constructor(options: SessionManagerOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.idFactory = options.idFactory ?? randomUUID;
    this.outputBufferBytes = options.outputBufferBytes ?? DEFAULT_OUTPUT_BUFFER_BYTES;
    this.maxSessions = options.maxSessions ?? 20;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 1_800_000;
    this.closeConfirmationTimeoutMs = options.closeConfirmationTimeoutMs ?? 10_000;
    this.retentionMs = options.retentionMs ?? 900_000;
    this.onStateChange = options.onStateChange;
    for (const value of [this.outputBufferBytes, this.maxSessions, this.idleTimeoutMs, this.closeConfirmationTimeoutMs, this.retentionMs]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError("会话限制必须为正安全整数");
    }
  }

  public reserve(input: { host: string; platform: "linux" | "windows"; shell: "posix" | "powershell"; columns: number; rows: number }): SessionSnapshot {
    if (this.shuttingDown || this.activeCount() >= this.maxSessions || this.records.size >= MAX_SESSION_RECORDS) {
      throw this.error(ErrorCodes.RESOURCE_LIMIT, "failed", "none");
    }
    const id = this.idFactory();
    if (id.length === 0 || this.records.has(id) || this.expired.has(id)) throw new Error("会话 ID 必须唯一且非空");
    const record: SessionRecord = {
      id, host: input.host, platform: input.platform, shell: input.shell, columns: input.columns, rows: input.rows,
      output: new OutputBuffer(this.outputBufferBytes), queue: new SessionInputQueue(), state: "opening",
      channel: undefined, connection: undefined, closeRequested: false, channelCloseRequested: false, forced: false,
      idleTimer: undefined, closeTimer: undefined, retentionTimer: undefined,
      nextFrameSeq: 0, resourcesClosed: false, pendingWriteTerminations: new Set()
    };
    this.records.set(id, record);
    const snapshot = this.snapshot(record);
    this.onStateChange?.(snapshot);
    this.publishChange();
    return snapshot;
  }

  /** 控制台只读取稳定排序的安全元数据，不包含 PTY 输出或写入口。 */
  public list(): readonly SessionSnapshot[] {
    return Object.freeze([...this.records.values()]
      .map((record) => this.snapshot(record))
      .sort((left, right) => left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0));
  }

  public subscribe(listener: () => void): () => void {
    this.subscribers.add(listener);
    return () => { this.subscribers.delete(listener); };
  }

  public activate(id: string, connection: SessionConnection, channel: SessionChannel): SessionSnapshot {
    const record = this.record(id);
    if (record.state !== "opening") throw this.error(ErrorCodes.SESSION_NOT_ACTIVE, "failed", "none", id, record.host);
    record.connection = connection;
    record.channel = channel;
    record.state = "active";
    this.observe(record);
    this.touch(record);
    const snapshot = this.snapshot(record);
    this.onStateChange?.(snapshot);
    this.publishChange();
    return snapshot;
  }

  /** 打开失败不会留下可查询句柄。 */
  public abandonOpening(id: string): void {
    const record = this.records.get(id);
    if (record?.state !== "opening") return;
    this.records.delete(id);
    this.publishChange();
  }

  public get(id: string, cursor = 0, maxBytes = DEFAULT_OUTPUT_READ_BYTES): SessionGetResult {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_OUTPUT_READ_BYTES) {
      throw this.error(ErrorCodes.INVALID_ARGUMENT, "failed", "none", id);
    }
    const record = this.record(id);
    try {
      const read = record.output.readEntries(cursor, maxBytes);
      if (record.state === "active") this.touch(record);
      return Object.freeze({
        ...this.snapshot(record),
        ...read,
        frames: Object.freeze(read.frames.map((frame) => this.sessionFrame(frame)))
      });
    } catch (error: unknown) {
      if (error instanceof OutputBufferError) throw this.error(ErrorCodes.INVALID_CURSOR, "failed", "none", id, record.host);
      throw error;
    }
  }

  /** 只读取元数据，不将内部前置校验误计为一次成功的用户输出读取。 */
  public describe(id: string): SessionSnapshot {
    return this.snapshot(this.record(id));
  }

  /** 将审批与副作用放入同一 FIFO 槽位。 */
  public enqueueInput<T>(id: string, action: () => Promise<T> | T): Promise<T> {
    const record = this.requireActive(id);
    return record.queue.enqueue(async () => {
      this.requireActive(id);
      return await action();
    });
  }

  public async write(id: string, data: Buffer): Promise<SessionSnapshot> {
    if (data.length === 0) throw this.error(ErrorCodes.INVALID_ARGUMENT, "failed", "none", id);
    const record = this.requireActive(id);
    try {
      await this.writeAccepted(record, Buffer.from(data));
    } catch {
      if (record.state === "active") this.finish(record, "unknown");
      throw this.error(ErrorCodes.STATE_UNKNOWN, "unknown", "possible", id, record.host, record);
    }
    this.touch(record);
    return this.snapshot(record);
  }

  public resize(id: string, columns: number, rows: number): SessionSnapshot {
    const record = this.requireActive(id);
    record.channel!.setWindow(rows, columns, 0, 0);
    record.columns = columns;
    record.rows = rows;
    this.touch(record);
    this.publishChange();
    return this.snapshot(record);
  }

  public close(id: string): SessionSnapshot {
    const record = this.record(id);
    if (record.state === "closed" || record.state === "disconnected" || record.state === "unknown") return this.snapshot(record);
    this.requestClose(record);
    return this.snapshot(record);
  }

  /** 幂等停止全部 PTY；截止时间内未收到关闭证据的会话保守标记为 unknown。 */
  public shutdown(timeoutMs = this.closeConfirmationTimeoutMs): Promise<void> {
    if (this.shutdownPromise !== undefined) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = new Promise((resolve) => {
      let deadlineTimer: unknown;
      const finishIfDone = (): void => {
        if (this.activeCount() !== 0) return;
        this.clear(deadlineTimer);
        this.shutdownWaiters.delete(finishIfDone);
        resolve();
      };
      this.shutdownWaiters.add(finishIfDone);
      for (const record of this.records.values()) {
        if (record.state === "opening" || record.state === "active" || record.state === "closing") this.requestClose(record);
      }
      finishIfDone();
      if (this.activeCount() === 0) return;
      deadlineTimer = this.clock.setTimeout(() => {
        for (const record of this.records.values()) {
          if (record.state !== "opening" && record.state !== "active" && record.state !== "closing") continue;
          record.forced = true;
          this.releaseResources(record);
          this.finish(record, "unknown");
        }
        this.shutdownWaiters.delete(finishIfDone);
        resolve();
      }, timeoutMs);
    });
    return this.shutdownPromise;
  }

  private observe(record: SessionRecord): void {
    const onData = (chunk: Buffer | string): void => {
      if (record.state !== "active") return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      record.output.append("pty", data, record.nextFrameSeq++);
      this.touch(record);
    };
    record.channel!.on("data", onData);
    record.channel!.stderr?.on("data", onData);
    record.channel!.on("error", () => {
      if (record.state === "active" || record.state === "closing") this.finish(record, "unknown");
    });
    record.channel!.on("exit", () => {
      if (record.state === "closing" && !record.forced) this.finish(record, "closed");
    });
    record.channel!.on("close", () => {
      if (record.forced) return;
      if (record.state === "closing") this.finish(record, "closed");
      else if (record.state === "active") this.finish(record, "disconnected");
    });
  }

  private requestClose(record: SessionRecord): void {
    if (record.state !== "opening" && record.state !== "active") return;
    record.state = "closing";
    this.onStateChange?.(this.snapshot(record));
    this.publishChange();
    this.terminatePendingWrites(record);
    this.clear(record.idleTimer);
    record.idleTimer = undefined;
    if (!record.closeRequested) {
      record.closeRequested = true;
      this.closeChannelOnce(record);
      if (record.channel === undefined) this.releaseResources(record);
    }
    // close() 可能同步触发 close 事件并令会话终态；此时不遗留无意义计时器。
    if (record.state !== "closing") return;
    record.closeTimer = this.clock.setTimeout(() => {
      if (record.state !== "closing") return;
      record.forced = true;
      this.releaseResources(record);
      this.finish(record, "unknown");
    }, this.closeConfirmationTimeoutMs);
  }

  private touch(record: SessionRecord): void {
    if (record.state !== "active") return;
    this.clear(record.idleTimer);
    record.idleTimer = this.clock.setTimeout(() => {
      if (record.state === "active") this.requestClose(record);
    }, this.idleTimeoutMs);
  }

  private finish(record: SessionRecord, state: Exclude<SessionState, "opening" | "active" | "closing">): void {
    if (record.state === "closed" || record.state === "disconnected" || record.state === "unknown") return;
    record.state = state;
    this.terminatePendingWrites(record);
    this.clear(record.idleTimer);
    this.clear(record.closeTimer);
    record.idleTimer = undefined;
    record.closeTimer = undefined;
    this.releaseResources(record);
    record.retentionTimer = this.clock.setTimeout(() => this.expire(record.id), this.retentionMs);
    this.onStateChange?.(this.snapshot(record));
    this.publishChange();
    for (const waiter of [...this.shutdownWaiters]) waiter();
  }

  private requireActive(id: string): SessionRecord {
    const record = this.record(id);
    if (record.state === "disconnected") throw this.error(ErrorCodes.SESSION_DISCONNECTED, "unknown", "possible", id, record.host, record);
    if (record.state !== "active") throw this.error(ErrorCodes.SESSION_NOT_ACTIVE, "failed", "none", id, record.host, record);
    return record;
  }

  private record(id: string): SessionRecord {
    const record = this.records.get(id);
    if (record !== undefined) return record;
    if (this.expired.has(id)) throw this.error(ErrorCodes.SESSION_EXPIRED, "failed", "none", id);
    throw this.error(ErrorCodes.SESSION_NOT_FOUND, "failed", "none", id);
  }

  private activeCount(): number {
    return [...this.records.values()].filter((record) => record.state === "opening" || record.state === "active" || record.state === "closing").length;
  }

  private expire(id: string): void {
    const record = this.records.get(id);
    if (record === undefined || record.state === "opening" || record.state === "active" || record.state === "closing") return;
    this.records.delete(id);
    this.expired.add(id);
    if (this.expired.size > MAX_EXPIRED_SESSION_IDS) {
      const oldest = this.expired.values().next().value;
      if (oldest !== undefined) this.expired.delete(oldest);
    }
    this.publishChange();
  }

  private publishChange(): void {
    for (const listener of [...this.subscribers]) {
      try { listener(); } catch { /* 控制台观察者不得影响会话生命周期。 */ }
    }
  }

  private clear(timer: unknown): void { if (timer !== undefined) this.clock.clearTimeout(timer); }

  private snapshot(record: SessionRecord): SessionSnapshot {
    return Object.freeze({ sessionId: record.id, host: record.host, platform: record.platform, shell: record.shell, state: record.state, columns: record.columns, rows: record.rows });
  }

  private sessionFrame(frame: OutputFrame & { readonly metadata: unknown }): SessionOutputFrame {
    const byteLength = frame.encoding === "utf8" ? Buffer.byteLength(frame.data, "utf8") : Buffer.from(frame.data, "base64").length;
    const { metadata, ...output } = frame;
    return Object.freeze({ ...output, seq: typeof metadata === "number" ? metadata : frame.cursor, byteLength });
  }

  private async writeAccepted(record: SessionRecord, data: Buffer): Promise<void> {
    const channel = record.channel;
    if (channel === undefined) throw new Error("PTY 通道不存在");
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let terminate = (): void => undefined;
      const clean = (): void => {
        channel.removeListener("error", onError);
        channel.removeListener("close", onClose);
        channel.removeListener("drain", onDrain);
        record.pendingWriteTerminations.delete(terminate);
      };
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clean();
        if (error === undefined) resolve(); else reject(error);
      };
      const onError = (error: unknown): void => settle(error instanceof Error ? error : new Error("PTY 写入失败"));
      const onClose = (): void => settle(new Error("PTY 已关闭"));
      const onDrain = (): void => settle();
      terminate = () => settle(new Error("PTY 会话已终止"));
      record.pendingWriteTerminations.add(terminate);
      channel.once("error", onError);
      channel.once("close", onClose);
      let accepted: boolean | void;
      try {
        accepted = channel.write(data, (error) => settle(error === null || error === undefined ? undefined : error));
      } catch (error: unknown) {
        settle(error instanceof Error ? error : new Error("PTY 写入失败"));
        return;
      }
      if (!settled && accepted === false) channel.once("drain", onDrain);
    });
  }

  private releaseResources(record: SessionRecord): void {
    if (record.resourcesClosed) return;
    record.resourcesClosed = true;
    this.closeChannelOnce(record);
    const connection = record.connection;
    record.channel = undefined;
    record.connection = undefined;
    try { connection?.close(); } catch { /* 清理失败不改变既定终态。 */ }
  }

  private closeChannelOnce(record: SessionRecord): void {
    if (record.channelCloseRequested) return;
    record.channelCloseRequested = true;
    try { record.channel?.close(); } catch { /* 清理失败不改变既定终态。 */ }
  }

  private terminatePendingWrites(record: SessionRecord): void {
    for (const terminate of [...record.pendingWriteTerminations]) terminate();
  }

  private error(
    code: McpOperationError["code"],
    finalState: McpOperationError["finalState"],
    sideEffects: McpOperationError["sideEffects"],
    sessionId?: string,
    host?: string,
    record?: SessionRecord
  ): SessionManagerError {
    return new SessionManagerError(createMcpOperationError({ code, message: code, finalState, retriable: false, sideEffects, sessionId, host }, undefined, {
      allowedSessionIds: sessionId === undefined ? undefined : new Set([sessionId]),
      allowedHosts: host === undefined ? undefined : new Set([host])
    }), record === undefined ? undefined : this.snapshot(record));
  }
}
