import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type ApprovalExecution, type ApprovalExecutionContext, type ApprovalExecutionOptions, type ApprovalService } from "../approval/approval-service.js";
import { createOperationIntent, type OperationIntent } from "../approval/operation-intent.js";
import type { HostConfig } from "../config/schema.js";
import { createMcpOperationError, ErrorCodes, type McpOperationError } from "../errors/error-contract.js";
import { HostRegistry } from "../hosts/host-registry.js";
import { OperationManagerError } from "../operations/operation-manager.js";
import { SessionManager, SessionManagerError, type SessionClock, type SessionSnapshot } from "../sessions/session-manager.js";
import { SshAdapterError, type SshAdapter, type SshConnection } from "../ssh/ssh-adapter.js";

const SessionOpenInputSchema = z.object({
  host: z.string().min(1), columns: z.number().int().min(1).max(500), rows: z.number().int().min(1).max(300)
}).strict();
const SessionWriteInputSchema = z.object({
  sessionId: z.string().min(1),
  data: z.object({
    encoding: z.enum(["utf8", "base64"]),
    value: z.string().min(1)
  }).strict().superRefine((data, context) => {
    if (data.encoding === "base64" && !isCanonicalBase64(data.value)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "base64 必须为规范编码" });
    }
  })
}).strict();
const SessionReadInputSchema = z.object({
  sessionId: z.string().min(1), cursor: z.number().int().min(0).optional(), maxBytes: z.number().int().min(1).max(262_144).optional()
}).strict();
const SessionResizeInputSchema = z.object({
  sessionId: z.string().min(1), columns: z.number().int().min(1).max(500), rows: z.number().int().min(1).max(300)
}).strict();
const SessionCloseInputSchema = z.object({ sessionId: z.string().min(1) }).strict();

const ErrorSchema = z.object({
  code: z.string(), message: z.string(), finalState: z.enum(["failed", "timed_out", "partial_failure", "unknown"]),
  retriable: z.boolean(), sideEffects: z.enum(["none", "possible", "partial", "confirmed"]),
  operationId: z.string().optional(), host: z.string().optional(), sessionId: z.string().optional(), details: z.record(z.unknown()).optional()
}).strict();
const SnapshotSchema = z.object({
  sessionId: z.string(), host: z.string(), platform: z.enum(["linux", "windows"]), shell: z.enum(["posix", "powershell"]),
  state: z.enum(["opening", "active", "closing", "closed", "disconnected", "unknown"]), columns: z.number().int(), rows: z.number().int()
}).strict();
const OpenSnapshotSchema = z.object({
  sessionId: z.string(), host: z.string(), platform: z.enum(["linux", "windows"]), shell: z.enum(["posix", "powershell"]),
  state: z.literal("active"), columns: z.number().int(), rows: z.number().int(), cursor: z.literal(0)
}).strict();
const FrameSchema = z.object({ stream: z.literal("pty"), seq: z.number().int(), cursor: z.number().int(), byteLength: z.number().int().positive(), encoding: z.enum(["utf8", "base64"]), data: z.string() }).strict();
const SessionOutputSchema = z.object({ session: SnapshotSchema.optional(), error: ErrorSchema.optional() }).strict();
const SessionOpenOutputSchema = z.object({ session: OpenSnapshotSchema.optional(), error: ErrorSchema.optional() }).strict();
const SessionReadOutputSchema = z.object({
  session: SnapshotSchema.optional(), frames: z.array(FrameSchema).optional(), nextCursor: z.number().int().optional(),
  minCursor: z.number().int().optional(), truncated: z.boolean().optional(), droppedBytes: z.number().int().optional(), error: ErrorSchema.optional()
}).strict();

interface SessionApprovalPort {
  execute<T>(intent: OperationIntent, sideEffect: (approvedIntent: OperationIntent, context?: ApprovalExecutionContext) => T | Promise<T>, options?: ApprovalExecutionOptions): Promise<ApprovalExecution<T>>;
}

export interface SessionToolDependencies {
  readonly registry: HostRegistry;
  readonly approval: SessionApprovalPort | ApprovalService;
  readonly sessions: SessionManager;
  readonly adapter: Pick<SshAdapter, "connect">;
  readonly clock?: Pick<SessionClock, "setTimeout" | "clearTimeout">;
}

const OPEN_SHELL_TIMEOUT_MS = 15_000;
const defaultClock: Pick<SessionClock, "setTimeout" | "clearTimeout"> = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout)
};

/** 五个交互会话 MCP 工具；输入 schema 不接受任何动态连接或 Shell 字段。 */
export function registerSessionTools(server: McpServer, dependencies: SessionToolDependencies): void {
  server.registerTool("session_open", {
    description: "经一次性审批建立一个登记主机上的独占 PTY Shell 会话",
    inputSchema: SessionOpenInputSchema, outputSchema: SessionOpenOutputSchema
  }, async ({ host: alias, columns, rows }) => {
    const host = dependencies.registry.get(alias);
    if (host === undefined) return errorResult(simpleError(ErrorCodes.HOST_NOT_REGISTERED));
    const intent = createOperationIntent({
      kind: "session_open", hosts: [host.alias], platformByHost: { [host.alias]: host.platform },
      payload: { columns, rows, shell: host.shell.type, shellCommand: host.shell.command }
    });
    try {
      const approval = await dependencies.approval.execute(intent, async (approved) => await openApprovedSession(dependencies, host, intent, approved), { timeoutKind: "session" });
      return approval.approved ? openSnapshotResult(approval.value) : errorResult(approval.error);
    } catch (error: unknown) { return caughtError(error); }
  });

  server.registerTool("session_write", {
    description: "经逐次审批向活动 PTY 精确写入 UTF-8 或 base64 原始字节",
    inputSchema: SessionWriteInputSchema, outputSchema: SessionOutputSchema
  }, async ({ sessionId, data }) => {
    try {
      const current = dependencies.sessions.describe(sessionId);
      const intent = createOperationIntent({
        kind: "session_input", hosts: [current.host], platformByHost: { [current.host]: current.platform },
        payload: { sessionId, data: { encoding: data.encoding, value: data.value } }
      });
      const snapshot = await dependencies.sessions.enqueueInput(sessionId, async () => {
        const approval = await dependencies.approval.execute(intent, (approved) => {
          // 回调中再次检查活动状态；只能使用已批准 Intent 的精确载荷。
          if (!matchesExpectedIntent(approved, intent) || !matchesSessionIntent(approved, "session_input", current)) {
            throw intentMismatchForSession(dependencies.sessions, sessionId);
          }
          if (!hasExactKeys(approved.payload, ["data", "sessionId"]) || approved.payload.sessionId !== sessionId) {
            throw intentMismatchForSession(dependencies.sessions, sessionId);
          }
          const payload = approved.payload.data;
          if (!isInputPayload(payload) || !hasExactKeys(payload, ["encoding", "value"])
            || payload.encoding !== data.encoding || payload.value !== data.value) throw intentMismatchForSession(dependencies.sessions, sessionId);
          return dependencies.sessions.write(approved.payload.sessionId, decodeInput(payload));
        }, { timeoutKind: "session" });
        if (!approval.approved) throw approvalFailureForSession(dependencies.sessions, sessionId, approval.error);
        return approval.value;
      });
      return snapshotResult(snapshot);
    } catch (error: unknown) { return caughtError(error); }
  });

  server.registerTool("session_read", {
    description: "读取一个会话的有界 PTY 原始输出，不触发审批或阻塞",
    inputSchema: SessionReadInputSchema, outputSchema: SessionReadOutputSchema
  }, async ({ sessionId, cursor, maxBytes }) => {
    try {
      const value = dependencies.sessions.get(sessionId, cursor, maxBytes);
      const structuredContent = { session: sessionOf(value), frames: value.frames, nextCursor: value.nextCursor, minCursor: value.minCursor, truncated: value.truncated, droppedBytes: value.droppedBytes };
      return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
    } catch (error: unknown) { return caughtReadError(error); }
  });

  server.registerTool("session_resize", {
    description: "经一次性审批设置活动 PTY 的精确终端尺寸",
    inputSchema: SessionResizeInputSchema, outputSchema: SessionOutputSchema
  }, async ({ sessionId, columns, rows }) => {
    try {
      const current = dependencies.sessions.describe(sessionId);
      const intent = createOperationIntent({
        kind: "session_resize", hosts: [current.host], platformByHost: { [current.host]: current.platform }, payload: { sessionId, columns, rows }
      });
      const snapshot = await dependencies.sessions.enqueueInput(sessionId, async () => {
        const approval = await dependencies.approval.execute(intent, (approved) => {
          const payload = approved.payload;
          if (!matchesExpectedIntent(approved, intent) || !matchesSessionIntent(approved, "session_resize", current)
            || !hasExactKeys(payload, ["columns", "rows", "sessionId"])
            || payload.sessionId !== sessionId || payload.columns !== columns || payload.rows !== rows
            || !isPositiveBounded(payload.columns, 500) || !isPositiveBounded(payload.rows, 300)) {
            throw intentMismatchForSession(dependencies.sessions, sessionId);
          }
          return dependencies.sessions.resize(payload.sessionId, payload.columns, payload.rows);
        }, { timeoutKind: "session" });
        if (!approval.approved) throw approvalFailureForSession(dependencies.sessions, sessionId, approval.error);
        return approval.value;
      });
      return snapshotResult(snapshot);
    } catch (error: unknown) { return caughtError(error); }
  });

  server.registerTool("session_close", {
    description: "关闭会话；对已关闭会话幂等且不需要审批",
    inputSchema: SessionCloseInputSchema, outputSchema: SessionOutputSchema
  }, async ({ sessionId }) => {
    try { return snapshotResult(dependencies.sessions.close(sessionId)); } catch (error: unknown) { return caughtError(error); }
  });
}

async function openApprovedSession(
  dependencies: SessionToolDependencies,
  host: HostConfig,
  expected: OperationIntent,
  approved: OperationIntent
): Promise<SessionSnapshot> {
  const payload = approved.payload;
  if (!matchesExpectedIntent(approved, expected) || !matchesHostIntent(approved, "session_open", host.alias, host.platform)
    || !hasExactKeys(payload, ["columns", "rows", "shell", "shellCommand"])
    || !isPositiveBounded(payload.columns, 500) || !isPositiveBounded(payload.rows, 300)
    || payload.shell !== host.shell.type || payload.shellCommand !== host.shell.command) throw intentMismatchError();
  const columns = payload.columns;
  const rows = payload.rows;
  const reserved = dependencies.sessions.reserve({ host: host.alias, platform: host.platform, shell: host.shell.type, columns, rows });
  let connection: SshConnection | undefined;
  try {
    connection = await dependencies.adapter.connect(host);
    const channel = await openShellWithinDeadline(connection, columns, rows, payload.shellCommand, dependencies.clock ?? defaultClock);
    return dependencies.sessions.activate(reserved.sessionId, connection, channel);
  } catch (error: unknown) {
    try { connection?.close(); } catch { /* 打开失败不保留资源。 */ }
    dependencies.sessions.abandonOpening(reserved.sessionId);
    // 已成功建立 SSH 连接后，shell 请求的失败无法证明远端没有创建终端；关闭失败。
    if (connection !== undefined) throw uncertainOpenError(host);
    throw error;
  }
}

function openShellWithinDeadline(
  connection: SshConnection,
  columns: number,
  rows: number,
  shellCommand: string,
  clock: Pick<SessionClock, "setTimeout" | "clearTimeout">
): Promise<Parameters<SessionManager["activate"]>[2]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: unknown;
    const settle = (error?: Error, channel?: Parameters<SessionManager["activate"]>[2]): void => {
      if (settled) {
        try { channel?.close(); } catch { /* 迟到 channel 不得激活。 */ }
        return;
      }
      settled = true;
      if (timer !== undefined) clock.clearTimeout(timer);
      if (error === undefined && channel !== undefined) resolve(channel); else reject(error ?? new Error("PTY 打开失败"));
    };
    timer = clock.setTimeout(() => settle(new Error("PTY 打开超时")), OPEN_SHELL_TIMEOUT_MS);
    connection.onClose?.(() => settle(new Error("SSH 连接已关闭")));
    try {
      connection.openShell(columns, rows, shellCommand, (error, channel) => {
        settle(error, channel as Parameters<SessionManager["activate"]>[2]);
      });
    } catch (error: unknown) {
      settle(error instanceof Error ? error : new Error("PTY 打开失败"));
    }
  });
}

function isInputPayload(value: unknown): value is { readonly encoding: "utf8" | "base64"; readonly value: string } {
  return typeof value === "object" && value !== null
    && ((value as { encoding?: unknown }).encoding === "utf8" || (value as { encoding?: unknown }).encoding === "base64")
    && typeof (value as { value?: unknown }).value === "string" && (value as { value: string }).value.length > 0
    && ((value as { encoding: string; value: string }).encoding !== "base64" || isCanonicalBase64((value as { value: string }).value));
}
function decodeInput(payload: { readonly encoding: "utf8" | "base64"; readonly value: string }): Buffer {
  return payload.encoding === "utf8" ? Buffer.from(payload.value, "utf8") : Buffer.from(payload.value, "base64");
}
function isCanonicalBase64(value: string): boolean {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}
function isPositiveBounded(value: unknown, maximum: number): value is number { return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= maximum; }
function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}
function matchesHostIntent(approved: OperationIntent, kind: OperationIntent["kind"], host: string, platform: "linux" | "windows"): boolean {
  return approved.kind === kind && approved.hosts.length === 1 && approved.hosts[0] === host
    && hasExactKeys(approved.platformByHost, [host]) && approved.platformByHost[host] === platform;
}
function matchesSessionIntent(approved: OperationIntent, kind: OperationIntent["kind"], session: SessionSnapshot): boolean {
  return matchesHostIntent(approved, kind, session.host, session.platform);
}
function matchesExpectedIntent(approved: OperationIntent, expected: OperationIntent): boolean {
  return approved.kind === expected.kind && approved.digest === expected.digest && approved.canonicalJson === expected.canonicalJson;
}
function sessionOf(value: SessionSnapshot): SessionSnapshot { return { sessionId: value.sessionId, host: value.host, platform: value.platform, shell: value.shell, state: value.state, columns: value.columns, rows: value.rows }; }
function simpleError(code: McpOperationError["code"]): McpOperationError { return createMcpOperationError({ code, message: code, finalState: "failed", retriable: false, sideEffects: "none" }); }
function snapshotResult(session: SessionSnapshot) { const structuredContent = { session }; return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent }; }
function openSnapshotResult(session: SessionSnapshot) {
  const structuredContent = { session: { ...sessionOf(session), state: "active" as const, cursor: 0 as const } };
  return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
}
function errorResult(error: McpOperationError, session?: SessionSnapshot) {
  const structuredContent = session === undefined ? { error } : { session: sessionOf(session), error };
  return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent, isError: true as const };
}
function uncertainOpenError(host: HostConfig): SessionManagerError {
  return new SessionManagerError(createMcpOperationError({
    code: ErrorCodes.STATE_UNKNOWN, message: ErrorCodes.STATE_UNKNOWN, finalState: "unknown", retriable: false, sideEffects: "possible", host: host.alias
  }, undefined, { allowedHosts: new Set([host.alias]) }));
}
function intentMismatchError(session?: SessionSnapshot): SessionManagerError {
  return new SessionManagerError(simpleError(ErrorCodes.APPROVAL_INTENT_MISMATCH), session);
}
function intentMismatchForSession(sessions: SessionManager, sessionId: string): SessionManagerError {
  return intentMismatchError(sessions.describe(sessionId));
}
function approvalFailureForSession(sessions: SessionManager, sessionId: string, error: McpOperationError): SessionManagerError {
  return new SessionManagerError(error, sessions.describe(sessionId));
}
function caughtError(error: unknown) {
  if (error instanceof SessionManagerError) return errorResult(error.error, error.session);
  if (error instanceof OperationManagerError) return errorResult(error.error);
  if (error instanceof SshAdapterError) return errorResult(simpleError(error.code));
  return errorResult(simpleError(ErrorCodes.INTERNAL_ERROR));
}
function caughtReadError(error: unknown) { return caughtError(error); }
