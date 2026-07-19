import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type ApprovalExecution, type ApprovalExecutionContext, type ApprovalExecutionOptions, type ApprovalService } from "../approval/approval-service.js";
import { createOperationIntent, type OperationIntent } from "../approval/operation-intent.js";
import { CommandRunner } from "../commands/command-runner.js";
import { ErrorCodes, createMcpOperationError, type McpOperationError } from "../errors/error-contract.js";
import { HostRegistry } from "../hosts/host-registry.js";
import { MultiHostCoordinator } from "../multihost/multi-host-coordinator.js";
import { OperationManagerError } from "../operations/operation-manager.js";

const CommandRunInputSchema = z.object({
  hosts: z.array(z.string().min(1)).min(1).max(10).refine((hosts) => new Set(hosts).size === hosts.length, "主机别名不可重复"),
  command: z.string().refine((command) => command.trim().length > 0, "命令不可为空白"),
  executionMode: z.enum(["parallel", "sequential"]).optional()
}).strict();
const CommandErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  finalState: z.enum(["failed", "timed_out", "partial_failure", "unknown"]),
  retriable: z.boolean(),
  sideEffects: z.enum(["none", "possible", "partial", "confirmed"]),
  operationId: z.string().optional(),
  host: z.string().optional(),
  sessionId: z.string().optional(),
  details: z.record(z.unknown()).optional()
}).strict();
const CommandRunOutputSchema = z.object({
  operationId: z.string().optional(),
  state: z.literal("running").optional(),
  error: CommandErrorSchema.optional()
}).strict();

interface CommandApprovalPort {
  execute<T>(intent: OperationIntent, sideEffect: (approvedIntent: OperationIntent, context?: ApprovalExecutionContext) => T | Promise<T>, options?: ApprovalExecutionOptions): Promise<ApprovalExecution<T>>;
}

export interface CommandRunDependencies {
  readonly registry: HostRegistry;
  readonly approval: CommandApprovalPort | ApprovalService;
  readonly runner: CommandRunner;
  readonly coordinator?: MultiHostCoordinator;
}

/** 原始命令的 MCP 外壳：完整主机集合在审批和任何操作创建之前解析。 */
export function registerCommandRunTool(server: McpServer, dependencies: CommandRunDependencies): void {
  server.registerTool("command_run", {
    description: "经一次性审批后在 1–10 个登记主机执行原始命令",
    inputSchema: CommandRunInputSchema,
    outputSchema: CommandRunOutputSchema
  }, async ({ hosts, command, executionMode }) => {
    const resolvedHosts = hosts.map((alias) => dependencies.registry.get(alias));
    if (resolvedHosts.some((host) => host === undefined)) {
      return errorResult(commandError(ErrorCodes.HOST_NOT_REGISTERED));
    }
    const registeredHosts = resolvedHosts as NonNullable<(typeof resolvedHosts)[number]>[];
    const intent = createOperationIntent({
      kind: "raw_command",
      hosts, platformByHost: Object.fromEntries(registeredHosts.map((host) => [host.alias, host.platform])),
      payload: { command },
      executionMode: executionMode ?? "parallel"
    });
    try {
      const approval = await dependencies.approval.execute(intent, (approvedIntent, context) => {
        if (!sameIntent(intent, approvedIntent)) throw new IntentMismatchError();
        const approvedCommand = approvedIntent.payload.command;
        if (typeof approvedCommand !== "string") throw new Error("审批命令载荷无效");
        if (registeredHosts.length === 1) {
          const snapshot = dependencies.runner.start(registeredHosts[0]!, approvedCommand, context?.operationId);
          context?.markBackground();
          return snapshot;
        }
        if (dependencies.coordinator === undefined) throw new Error("多主机协调器不可用");
        const snapshot = dependencies.coordinator.start({
          hosts: registeredHosts, executionMode: approvedIntent.executionMode ?? "parallel", timeoutKind: "command",
          failureCode: ErrorCodes.COMMAND_FAILED, timeoutCode: ErrorCodes.COMMAND_TIMEOUT,
          start: (host) => dependencies.runner.start(host, approvedCommand)
        }, context?.operationId);
        context?.markBackground();
        return snapshot;
      }, { timeoutKind: "command" });
      if (!approval.approved) return errorResult(approval.error);
      return successResult(approval.value);
    } catch (error: unknown) {
      if (error instanceof IntentMismatchError) return errorResult(commandError(ErrorCodes.APPROVAL_INTENT_MISMATCH));
      if (error instanceof OperationManagerError) return errorResult(error.error);
      throw error;
    }
  });
}

class IntentMismatchError extends Error {}

function sameIntent(expected: OperationIntent, approved: OperationIntent): boolean {
  return expected.kind === approved.kind && expected.digest === approved.digest && expected.canonicalJson === approved.canonicalJson;
}

function commandError(code: McpOperationError["code"]): McpOperationError {
  return createMcpOperationError({ code, message: code, finalState: "failed", retriable: false, sideEffects: "none" });
}

function successResult(snapshot: { operationId: string; state: string }) {
  const structuredContent = { operationId: snapshot.operationId, state: "running" as const };
  return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
}

function errorResult(error: McpOperationError) {
  const structuredContent = { error };
  return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent, isError: true as const };
}
