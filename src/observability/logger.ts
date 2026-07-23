import { isErrorCode, type ErrorCode } from "../errors/error-codes.js";

export interface LogSink {
  write(line: string): void;
}

export interface LogClock {
  now(): Date;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export const LogEvents = {
  SERVICE_STARTED: "service.started",
  SERVICE_STOPPED: "service.stopped",
  CONFIG_GENERATED: "config.generated",
  CONFIG_LOADED: "config.loaded",
  APPROVAL_RESULT: "approval.result",
  OPERATION_APPROVAL: "operation.approval",
  HOST_TRUST_RESULT: "host_trust.result",
  CONNECTION_STATE_CHANGED: "connection.state_changed",
  OPERATION_STATE_CHANGED: "operation.state_changed",
  OUTPUT_TRUNCATED: "output.truncated",
  TRANSFER_PROGRESS: "transfer.progress",
  CLEANUP_RESULT: "cleanup.result",
  CONSOLE_READY: "console.ready"
} as const;

export type LogEvent = (typeof LogEvents)[keyof typeof LogEvents];

export const LogStates = {
  NOT_STARTED: "not_started",
  AWAITING_APPROVAL: "awaiting_approval",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  OPENING: "opening",
  ACTIVE: "active",
  CLOSING: "closing",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  TIMED_OUT: "timed_out",
  CANCELLED: "cancelled",
  PARTIAL_FAILURE: "partial_failure",
  DISCONNECTED: "disconnected",
  CLOSED: "closed",
  UNKNOWN: "unknown"
} as const;

export type LogState = (typeof LogStates)[keyof typeof LogStates];

export interface KnownCorrelationValues {
  readonly allowedOperationIds?: ReadonlySet<string>;
  readonly allowedSessionIds?: ReadonlySet<string>;
  readonly allowedHosts?: ReadonlySet<string>;
}

export interface LogContext {
  readonly operationId?: string;
  readonly sessionId?: string;
  readonly host?: string;
  readonly state?: LogState;
  readonly durationMs?: number;
  readonly errorCode?: ErrorCode;
  /** 仅保留已脱敏内容；日志之外不记录原始诊断。 */
  readonly details?: Readonly<Record<string, unknown>>;
}

const safeDetailReasons = new Set(["cancel", "cancelled", "disconnected", "timeout"]);
const safeTimeoutKinds = new Set(["connect", "command", "session", "transfer", "approval"]);
const safeTemporaryCleanupStates = new Set(["not_needed", "removed", "failed", "unknown"]);
const safeFinalTargetCommitStates = new Set(["not_committed", "committed", "unknown"]);
const safeCommitOutcomes = new Set(["unknown"]);
const safeNumericDetails = new Set([
  "droppedBytes", "minCursor", "transferredBytes", "aggregateTransferredBytes", "totalBytes", "completedItems", "totalItems"
]);
const sha256Pattern = /^[a-f0-9]{64}$/;
const logEventValues = new Set<unknown>(Object.values(LogEvents));
const logStateValues = new Set<unknown>(Object.values(LogStates));

export class SecretRedactor {
  public constructor(_options: { readonly privateKeyPaths?: Iterable<string> } = {}) {}

  public redact(value: unknown): unknown {
    if (!isPlainObject(value)) {
      return {};
    }
    const details: Record<string, string | number> = {};
    for (const [key, detail] of Object.entries(value)) {
      if (key === "reason" && typeof detail === "string" && safeDetailReasons.has(detail)) {
        details.reason = detail;
      }
      if (key === "timeoutKind" && typeof detail === "string" && safeTimeoutKinds.has(detail)) {
        details.timeoutKind = detail;
      }
      if (key === "digest" && typeof detail === "string" && sha256Pattern.test(detail)) {
        details.digest = detail;
      }
      if (key === "temporaryCleanup" && typeof detail === "string" && safeTemporaryCleanupStates.has(detail)) {
        details.temporaryCleanup = detail;
      }
      if (key === "finalTargetCommit" && typeof detail === "string" && safeFinalTargetCommitStates.has(detail)) {
        details.finalTargetCommit = detail;
      }
      if (key === "commitOutcome" && typeof detail === "string" && safeCommitOutcomes.has(detail)) {
        details.commitOutcome = detail;
      }
      if (safeNumericDetails.has(key) && typeof detail === "number" && Number.isSafeInteger(detail) && detail >= 0) {
        details[key] = detail;
      }
    }
    return details;
  }

  public redactMessage(_message: string): string {
    // 任意诊断文本均可能包含无法可靠解析的秘密，客户端和日志边界一律不保留它。
    return "<message-redacted>";
  }

}

export class JsonLogger {
  public constructor(
    private readonly sink: LogSink = stderrSink,
    private readonly clock: LogClock = systemLogClock,
    private readonly redactor: SecretRedactor = new SecretRedactor(),
    private readonly knownValues: KnownCorrelationValues = {}
  ) {}

  public debug(event: LogEvent, context: LogContext = {}): void {
    this.write("debug", event, context);
  }

  public info(event: LogEvent, context: LogContext = {}): void {
    this.write("info", event, context);
  }

  public warn(event: LogEvent, context: LogContext = {}): void {
    this.write("warn", event, context);
  }

  public error(event: LogEvent, context: LogContext = {}): void {
    this.write("error", event, context);
  }

  /** 唯一允许完整能力 URL 的结构化诊断出口；普通 context/details 仍会删除该字段。 */
  public consoleReady(accessUrl: string): void {
    if (!/^http:\/\/[a-z0-9]{16,64}\.localhost:\d{1,5}\/#access_token=[A-Za-z0-9_-]{43,128}$/.test(accessUrl)) {
      throw new Error("控制台访问 URL 格式无效");
    }
    this.sink.write(`${JSON.stringify({
      timestamp: this.clock.now().toISOString(),
      level: "info",
      event: LogEvents.CONSOLE_READY,
      state: "active",
      accessUrl
    })}\n`);
  }

  private write(level: LogLevel, event: LogEvent, context: LogContext): void {
    const snapshot = snapshotContext(context);
    const record = {
      timestamp: this.clock.now().toISOString(),
      level,
      event: isSafeEvent(event) ? event : "<event-redacted>",
      ...(isKnownValue(snapshot.operationId, this.knownValues.allowedOperationIds)
        ? { operationId: snapshot.operationId }
        : {}),
      ...(isKnownValue(snapshot.sessionId, this.knownValues.allowedSessionIds)
        ? { sessionId: snapshot.sessionId }
        : {}),
      ...(isKnownValue(snapshot.host, this.knownValues.allowedHosts) ? { host: snapshot.host } : {}),
      ...(isSafeState(snapshot.state) ? { state: snapshot.state } : {}),
      ...(isSafeDuration(snapshot.durationMs) ? { durationMs: snapshot.durationMs } : {}),
      ...(isErrorCode(snapshot.errorCode) ? { errorCode: snapshot.errorCode } : {}),
      ...(snapshot.details === undefined ? {} : { details: this.redactor.redact(snapshot.details) })
    };
    this.sink.write(`${JSON.stringify(record)}\n`);
  }
}

const stderrSink: LogSink = {
  write: (line) => process.stderr.write(line)
};

const systemLogClock: LogClock = {
  now: () => new Date()
};

function isSafeEvent(value: unknown): value is LogEvent {
  return logEventValues.has(value);
}

function isKnownValue(value: unknown, allowedValues: ReadonlySet<string> | undefined): value is string {
  return typeof value === "string" && allowedValues?.has(value) === true;
}

function isSafeState(value: unknown): value is LogState {
  return logStateValues.has(value);
}

function isSafeDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function snapshotContext(context: LogContext): Record<keyof LogContext, unknown> {
  return {
    operationId: context.operationId,
    sessionId: context.sessionId,
    host: context.host,
    state: context.state,
    durationMs: context.durationMs,
    errorCode: context.errorCode,
    details: context.details
  };
}
