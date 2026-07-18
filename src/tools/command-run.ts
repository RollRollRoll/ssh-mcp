import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type ApprovalExecution, type ApprovalService } from "../approval/approval-service.js";
import { createOperationIntent, type OperationIntent } from "../approval/operation-intent.js";
import { CommandRunner } from "../commands/command-runner.js";
import { ErrorCodes, createMcpOperationError, type McpOperationError } from "../errors/error-contract.js";
import { HostRegistry } from "../hosts/host-registry.js";
import { OperationManagerError } from "../operations/operation-manager.js";

const CommandRunInputSchema = z.object({
  hosts: z.array(z.string().min(1)).length(1).refine((hosts) => new Set(hosts).size === hosts.length, "主机别名不可重复"),
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
  execute<T>(intent: OperationIntent, sideEffect: (approvedIntent: OperationIntent) => T | Promise<T>): Promise<ApprovalExecution<T>>;
}

export interface CommandRunDependencies {
  readonly registry: HostRegistry;
  readonly approval: CommandApprovalPort | ApprovalService;
  readonly runner: CommandRunner;
}

/** 单主机 raw command 的 MCP 外壳：解析主机在审批和操作创建之前完成。 */
export function registerCommandRunTool(server: McpServer, dependencies: CommandRunDependencies): void {
  server.registerTool("command_run", {
    description: "经一次性审批后在一个登记主机执行原始命令",
    inputSchema: CommandRunInputSchema,
    outputSchema: CommandRunOutputSchema
  }, async ({ hosts, command, executionMode }) => {
    const host = dependencies.registry.get(hosts[0]!);
    if (host === undefined) {
      return errorResult(commandError(ErrorCodes.HOST_NOT_REGISTERED));
    }
    const intent = createOperationIntent({
      kind: "raw_command",
      hosts,
      platformByHost: { [host.alias]: host.platform },
      payload: { command },
      executionMode: executionMode ?? "parallel"
    });
    try {
      const approval = await dependencies.approval.execute(intent, (approvedIntent) => {
        const approvedCommand = approvedIntent.payload.command;
        if (typeof approvedCommand !== "string") throw new Error("审批命令载荷无效");
        return dependencies.runner.start(host, approvedCommand);
      });
      if (!approval.approved) return errorResult(approval.error);
      return successResult(approval.value);
    } catch (error: unknown) {
      if (error instanceof OperationManagerError) return errorResult(error.error);
      throw error;
    }
  });
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
