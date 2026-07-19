import { createMcpOperationError, type McpOperationError } from "../errors/error-contract.js";
import { ErrorCodes, isErrorCode } from "../errors/error-codes.js";
import type { HostConfig } from "../config/schema.js";
import { OperationManager, type OperationRunner, type OperationSnapshot } from "../operations/operation-manager.js";
import { SshAdapter, type SshConnection } from "../ssh/ssh-adapter.js";
import { buildCommand } from "./command-builder.js";

interface CommandChannel {
  readonly stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  signal(signal: string): void;
  close(): void;
  on(event: "data", listener: (chunk: Buffer | string) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: (code: number | null | undefined, signal: string | null | undefined) => void): this;
  on(event: "exit", listener: (code: number | null | undefined, signal: string | null | undefined) => void): this;
}

type ExecutionPhase = "connect_pending" | "connection_ready" | "exec_submitted" | "channel_active";

export interface CommandResult extends Readonly<Record<string, unknown>> {
  readonly host: string;
  readonly platform: "linux" | "windows";
  readonly exitCode?: number;
  readonly signal?: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}

/** 一次运行只创建一个连接；运行器从已审批 Intent 的命令启动，不重试或重放。 */
export class CommandRunner {
  public constructor(
    private readonly adapter: Pick<SshAdapter, "connect">,
    private readonly manager: OperationManager,
    private readonly connectTimeoutMs = 15_000
  ) {}

  public start(host: HostConfig, command: string, operationId?: string): OperationSnapshot {
    const execution = new CommandExecution(this.adapter, this.manager, host, command, this.connectTimeoutMs, operationId);
    return execution.start();
  }
}

class CommandExecution implements OperationRunner {
  private operationId = "";
  private connection: SshConnection | undefined;
  private channel: CommandChannel | undefined;
  private phase: ExecutionPhase = "connect_pending";
  private stopping = false;
  private forced = false;
  private stopReason: "cancel" | "timeout" | undefined;
  private termSent = false;
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private exitCode: number | undefined;
  private exitSignal: string | undefined;

  public constructor(
    private readonly adapter: Pick<SshAdapter, "connect">,
    private readonly manager: OperationManager,
    private readonly host: HostConfig,
    private readonly rawCommand: string,
    private readonly connectTimeoutMs: number,
    private readonly existingOperationId?: string
  ) {}

  public start(): OperationSnapshot {
    const snapshot = this.existingOperationId === undefined
      ? this.manager.create({ initialState: "running", runner: this, timeoutKind: "command" })
      : this.manager.attachRunner(this.existingOperationId, this, "command");
    this.operationId = snapshot.operationId;
    queueMicrotask(() => { void this.run(); });
    return snapshot;
  }

  public cancel(reason: "cancel" | "timeout"): void {
    if (this.stopping) return;
    this.stopping = true;
    this.stopReason = reason;
    if (this.phase === "connect_pending" || this.phase === "connection_ready") {
      // 此时尚未提交 exec，请求确认不会掩盖任何远端命令副作用。
      this.connection?.close();
      this.manager.confirmStopped(this.operationId, this.result(), this.stopError());
      return;
    }
    if (this.phase === "channel_active") this.sendTermOnce();
    // exec 已提交但 callback 未到时无法证明远端是否已执行；等待 close/exit 或强制 unknown。
  }

  public forceStop(): CommandResult {
    // 必须先置位，防止 close() 同步触发的迟到事件伪造停止确认。
    this.forced = true;
    try { this.channel?.close(); } catch { /* 尽力关闭 */ }
    this.connection?.close();
    return this.result();
  }

  private async run(): Promise<void> {
    try {
      const connection = await this.adapter.connect(this.host, this.connectTimeoutMs);
      this.connection = connection;
      this.phase = "connection_ready";
      if (this.stopping) {
        connection.close();
        return;
      }
      this.phase = "exec_submitted";
      connection.exec(buildCommand(this.host, this.rawCommand), (error, channel) => {
        if (error !== undefined) {
          if (!this.stopping) {
            this.manager.fail(this.operationId, this.error(this.errorCode(error), "failed", "none"), this.result());
          }
          connection.close();
          return;
        }
        this.phase = "channel_active";
        this.observe(channel as CommandChannel);
        // 已先注册 close/exit 监听；若取消发生在 callback 前，TERM 只在此处发送一次。
        if (this.stopping && !this.forced) this.sendTermOnce();
      });
    } catch (error: unknown) {
      if (this.stopping) return;
      this.manager.fail(this.operationId, this.error(this.errorCode(error), "failed", "none"), this.result());
    }
  }

  private observe(channel: CommandChannel): void {
    this.channel = channel;
    channel.on("data", (chunk) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.stdoutBytes += data.length;
      this.manager.appendOutput(this.operationId, "stdout", data);
    });
    channel.stderr.on("data", (chunk) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.stderrBytes += data.length;
      this.manager.appendOutput(this.operationId, "stderr", data);
    });
    channel.on("error", () => {
      if (!this.stopping) {
        this.manager.unknown(this.operationId, this.error(ErrorCodes.STATE_UNKNOWN, "unknown", "possible"), this.result());
        this.connection?.close();
      }
    });
    channel.on("exit", (code, signal) => {
      this.rememberExit(code, signal);
      if (this.stopping && !this.forced && this.hasExitEvidence()) this.confirmRemoteStopped();
    });
    channel.on("close", (code, signal) => {
      this.rememberExit(code, signal);
      this.connection?.close();
      if (this.stopping) {
        if (!this.forced && this.hasExitEvidence()) this.confirmRemoteStopped();
        return;
      }
      const result = this.result();
      if (this.exitCode === 0) this.manager.complete(this.operationId, result);
      else if (this.exitCode !== undefined || this.exitSignal !== undefined) {
        this.manager.fail(this.operationId, this.error(ErrorCodes.COMMAND_FAILED, "failed", "confirmed"), result);
      } else {
        this.manager.unknown(this.operationId, this.error(ErrorCodes.STATE_UNKNOWN, "unknown", "possible"), result);
      }
    });
  }

  private sendTermOnce(): void {
    if (this.termSent || this.forced || this.channel === undefined) return;
    this.termSent = true;
    try { this.channel.signal("TERM"); } catch { /* 等待确认窗口收敛为 unknown。 */ }
  }

  private confirmRemoteStopped(): void {
    this.manager.confirmStopped(this.operationId, this.result(), this.stopError());
  }

  private rememberExit(exitCode: number | null | undefined, signal: string | null | undefined): void {
    if (typeof exitCode === "number") this.exitCode = exitCode;
    if (typeof signal === "string") this.exitSignal = signal;
  }

  private hasExitEvidence(): boolean {
    return this.exitCode !== undefined || this.exitSignal !== undefined;
  }

  private result(): CommandResult {
    return Object.freeze({
      host: this.host.alias,
      platform: this.host.platform,
      ...(this.exitCode === undefined ? {} : { exitCode: this.exitCode }),
      ...(this.exitSignal === undefined ? {} : { signal: this.exitSignal }),
      stdoutBytes: this.stdoutBytes,
      stderrBytes: this.stderrBytes
    });
  }

  private stopError(): McpOperationError | undefined {
    return this.stopReason === "timeout"
      ? this.error(ErrorCodes.COMMAND_TIMEOUT, "timed_out", "confirmed")
      : undefined;
  }

  private error(
    code: McpOperationError["code"],
    finalState: McpOperationError["finalState"],
    sideEffects: McpOperationError["sideEffects"]
  ): McpOperationError {
    return createMcpOperationError({
      code,
      message: code,
      finalState,
      retriable: false,
      sideEffects,
      operationId: this.operationId,
      host: this.host.alias
    }, undefined, {
      allowedOperationIds: new Set([this.operationId]),
      allowedHosts: new Set([this.host.alias])
    });
  }

  private errorCode(error: unknown): McpOperationError["code"] {
    return error instanceof Error && "code" in error && isErrorCode(error.code)
      ? error.code
      : ErrorCodes.INTERNAL_ERROR;
  }
}
