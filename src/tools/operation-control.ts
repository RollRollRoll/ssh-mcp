import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OperationManager, OperationManagerError } from "../operations/operation-manager.js";

const OperationIdSchema = z.string().min(1);
const OperationGetInputSchema = z.object({
  operationId: OperationIdSchema,
  cursor: z.number().optional(),
  maxBytes: z.number().optional()
}).strict();
const OperationCancelInputSchema = z.object({ operationId: OperationIdSchema }).strict();

const ErrorDetailsSchema = z.record(z.unknown());
const ErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    finalState: z.enum(["failed", "timed_out", "partial_failure", "unknown"]),
    retriable: z.boolean(),
    sideEffects: z.enum(["none", "possible", "partial", "confirmed"]),
    operationId: z.string().optional(),
    host: z.string().optional(),
    sessionId: z.string().optional(),
    details: ErrorDetailsSchema.optional()
  }).strict()
}).strict();
const StateSchema = z.enum(["awaiting_approval", "running", "completed", "failed", "timed_out", "cancelled", "partial_failure", "unknown"]);
const OperationGetOutputSchema = z.object({
  operationId: z.string().optional(),
  state: StateSchema.optional(),
  frames: z.array(z.object({ stream: z.enum(["stdout", "stderr"]), cursor: z.number(), encoding: z.enum(["utf8", "base64"]), data: z.string(), host: z.string().optional() })).optional(),
  nextCursor: z.number().optional(),
  minCursor: z.number().optional(),
  truncated: z.boolean().optional(),
  droppedBytes: z.number().optional(),
  result: z.record(z.unknown()).optional(),
  error: ErrorSchema.shape.error.optional()
});
const OperationCancelOutputSchema = z.object({
  operationId: z.string().optional(),
  state: StateSchema.optional(),
  error: ErrorSchema.shape.error.optional()
});

export function registerOperationControlTools(server: McpServer, manager: OperationManager): void {
  server.registerTool("operation_get", {
    description: "读取操作状态及按原始字节游标分页的 stdout/stderr 输出",
    inputSchema: OperationGetInputSchema,
    outputSchema: OperationGetOutputSchema
  }, ({ operationId, cursor, maxBytes }) => operationResult(() => manager.get(operationId, cursor, maxBytes)));

  server.registerTool("operation_cancel", {
    description: "请求停止操作；最终停止确认通过 operation_get 查询",
    inputSchema: OperationCancelInputSchema,
    outputSchema: OperationCancelOutputSchema
  }, ({ operationId }) => operationResult(() => manager.cancel(operationId)));
}

function operationResult<T extends object>(action: () => T) {
  try {
    const structuredContent = action();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
      structuredContent: structuredContent as Record<string, unknown>
    };
  } catch (error: unknown) {
    const operationError = error instanceof OperationManagerError
      ? error.error
      : undefined;
    if (operationError === undefined) {
      throw error;
    }
    const structuredContent = { error: operationError };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
      structuredContent,
      isError: true as const
    };
  }
}
