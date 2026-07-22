import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type ApprovalService } from "../approval/approval-service.js";
import { CommandRunner } from "../commands/command-runner.js";
import {
  ApplicationServiceError,
  CommandApplicationService,
  type CommandApprovalPort
} from "../application/command-application-service.js";
import type { McpOperationError } from "../errors/error-contract.js";
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

export interface CommandRunDependencies {
  readonly registry: HostRegistry;
  readonly approval: CommandApprovalPort | ApprovalService;
  readonly runner: CommandRunner;
  readonly coordinator?: MultiHostCoordinator;
  readonly application?: CommandApplicationService;
}

/** 原始命令的 MCP 外壳：完整主机集合在审批和任何操作创建之前解析。 */
export function registerCommandRunTool(server: McpServer, dependencies: CommandRunDependencies): void {
  const application = dependencies.application ?? new CommandApplicationService(
    dependencies.registry, dependencies.approval, dependencies.runner, dependencies.coordinator
  );
  server.registerTool("command_run", {
    description: "经一次性审批后在 1–10 个登记主机执行原始命令",
    inputSchema: CommandRunInputSchema,
    outputSchema: CommandRunOutputSchema
  }, async ({ hosts, command, executionMode }) => {
    try {
      const approval = await application.execute({ source: "mcp", hosts, command, executionMode });
      if (!approval.approved) return errorResult(approval.error);
      return successResult(approval.value);
    } catch (error: unknown) {
      if (error instanceof ApplicationServiceError) return errorResult(error.error);
      if (error instanceof OperationManagerError) return errorResult(error.error);
      throw error;
    }
  });
}

function successResult(snapshot: { operationId: string; state: string }) {
  const structuredContent = { operationId: snapshot.operationId, state: "running" as const };
  return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
}

function errorResult(error: McpOperationError) {
  const structuredContent = { error };
  return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent, isError: true as const };
}
