import { SecretRedactor, type KnownCorrelationValues } from "../observability/logger.js";
import { ErrorCodes, isErrorCode, type ErrorCode } from "./error-codes.js";

export { ErrorCodes } from "./error-codes.js";
export type { ErrorCode } from "./error-codes.js";
export type FinalState = "failed" | "timed_out" | "partial_failure" | "unknown";
export type SideEffects = "none" | "possible" | "partial" | "confirmed";

export interface McpOperationError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly finalState: FinalState;
  readonly retriable: boolean;
  readonly sideEffects: SideEffects;
  readonly operationId?: string;
  readonly host?: string;
  readonly sessionId?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export function createMcpOperationError(
  error: McpOperationError,
  redactor: SecretRedactor = new SecretRedactor(),
  knownValues: KnownCorrelationValues = {}
): McpOperationError {
  const snapshot = {
    code: error.code,
    message: error.message,
    finalState: error.finalState,
    retriable: error.retriable,
    sideEffects: error.sideEffects,
    operationId: error.operationId,
    host: error.host,
    sessionId: error.sessionId,
    details: error.details
  };
  const code = isErrorCode(snapshot.code) ? snapshot.code : ErrorCodes.INTERNAL_ERROR;
  const finalState = isFinalState(snapshot.finalState) ? snapshot.finalState : "failed";
  const retriable = typeof snapshot.retriable === "boolean" ? snapshot.retriable : false;
  const sideEffects = isSideEffects(snapshot.sideEffects) ? snapshot.sideEffects : "none";
  const details = snapshot.details === undefined
    ? undefined
    : freezeRecursively(code === ErrorCodes.HOST_KEY_CHANGED
      ? hostKeyChangedDetails(snapshot.details)
      : redactor.redact(snapshot.details));
  return Object.freeze({
    code,
    // 调用方 message 可能包含 SSH、认证或配置原文，绝不进入客户端错误结构。
    message: errorMessages[code],
    finalState,
    retriable,
    sideEffects,
    ...(isKnownValue(snapshot.operationId, knownValues.allowedOperationIds)
      ? { operationId: snapshot.operationId }
      : {}),
    ...(isKnownValue(snapshot.host, knownValues.allowedHosts) ? { host: snapshot.host } : {}),
    ...(isKnownValue(snapshot.sessionId, knownValues.allowedSessionIds)
      ? { sessionId: snapshot.sessionId }
      : {}),
    ...(details === undefined ? {} : { details: details as Readonly<Record<string, unknown>> })
  });
}

/** 只从 HOST_KEY_CHANGED 异常链提取两个可公开的 OpenSSH SHA256 指纹。 */
export function extractHostKeyChangedDetails(error: unknown): Readonly<Record<string, unknown>> | undefined {
  let current = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 4 && current !== null && typeof current === "object" && !seen.has(current); depth += 1) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (record.code === ErrorCodes.HOST_KEY_CHANGED) {
      return hostKeyChangedDetails(record.details);
    }
    current = record.originalError;
  }
  return undefined;
}

function hostKeyChangedDetails(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { oldFingerprint, newFingerprint } = value as Record<string, unknown>;
  if (!isSha256Fingerprint(oldFingerprint) || !isSha256Fingerprint(newFingerprint)) return undefined;
  return { oldFingerprint, newFingerprint };
}

function isSha256Fingerprint(value: unknown): value is string {
  if (typeof value !== "string" || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(value)) return false;
  try { return Buffer.from(value.slice(7), "base64").length === 32; } catch { return false; }
}

const errorMessages: Record<ErrorCode, string> = {
  INVALID_ARGUMENT: "请求参数无效。",
  INVALID_CURSOR: "游标无效。",
  CONFIG_INVALID: "配置无效。",
  CONFIG_VERSION_UNSUPPORTED: "配置版本不受支持。",
  RESOURCE_LIMIT: "资源限制已触发。",
  HOST_NOT_REGISTERED: "主机未注册。",
  HOST_KEY_REJECTED: "主机密钥被拒绝。",
  HOST_KEY_CHANGED: "主机密钥已变更。",
  CONNECTION_REFUSED: "连接被拒绝。",
  CONNECTION_TIMEOUT: "连接超时。",
  PLATFORM_MISMATCH: "目标平台不匹配。",
  AUTH_UNAVAILABLE: "认证不可用。",
  AUTH_FAILED: "认证失败。",
  INTERACTIVE_AUTH_UNSUPPORTED: "不支持交互式认证。",
  APPROVAL_UNSUPPORTED: "客户端不支持操作审批。",
  APPROVAL_DECLINED: "操作审批未通过。",
  APPROVAL_TIMEOUT: "操作审批超时。",
  APPROVAL_INTENT_MISMATCH: "操作意图完整性校验失败。",
  POLICY_NOT_FOUND: "未找到策略。",
  POLICY_DENIED: "策略拒绝该操作。",
  POLICY_REQUIRES_APPROVAL: "操作需要审批。",
  COMMAND_FAILED: "命令执行失败。",
  COMMAND_TIMEOUT: "命令执行超时。",
  OUTPUT_TRUNCATED: "输出已截断。",
  SESSION_NOT_FOUND: "会话不存在。",
  SESSION_EXPIRED: "会话已过期。",
  SESSION_NOT_ACTIVE: "会话未激活。",
  SESSION_DISCONNECTED: "会话已断开。",
  PATH_DENIED: "路径被拒绝。",
  LINK_NOT_ALLOWED: "不允许链接目标。",
  TARGET_EXISTS: "目标已存在。",
  ATOMIC_REPLACE_UNSUPPORTED: "不支持原子替换。",
  TRANSFER_FAILED: "传输失败。",
  TRANSFER_TIMEOUT: "传输超时。",
  PARTIAL_FAILURE: "操作部分失败。",
  OPERATION_NOT_FOUND: "操作不存在。",
  OPERATION_EXPIRED: "操作已过期。",
  CANCEL_UNCONFIRMED: "取消未确认。",
  STATE_UNKNOWN: "操作状态未知。",
  TRUST_STORE_ERROR: "信任存储错误。",
  CONSOLE_LISTEN_DENIED: "本机控制台监听被运行环境拒绝。",
  CONSOLE_START_FAILED: "本机控制台启动失败。",
  INTERNAL_ERROR: "内部错误。"
};

const finalStates = new Set<unknown>(["failed", "timed_out", "partial_failure", "unknown"]);
const sideEffectValues = new Set<unknown>(["none", "possible", "partial", "confirmed"]);

function isFinalState(value: unknown): value is FinalState {
  return finalStates.has(value);
}

function isSideEffects(value: unknown): value is SideEffects {
  return sideEffectValues.has(value);
}

function isKnownValue(value: unknown, allowedValues: ReadonlySet<string> | undefined): value is string {
  return typeof value === "string" && allowedValues?.has(value) === true;
}

function freezeRecursively<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const nested of Object.values(value)) {
    freezeRecursively(nested, seen);
  }
  return Object.freeze(value);
}
