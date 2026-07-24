import {
  McpServer,
  type RegisteredTool,
  type ToolCallback
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

interface ToolCallWarning {
  readonly type: "warning";
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

interface ToolCallConsoleReady {
  readonly type: "console_ready";
  readonly message: string;
  readonly accessUrl: string;
}

export type ToolCallNotice = ToolCallWarning | ToolCallConsoleReady;

export type ToolCallGate = () => Promise<ToolCallNotice | undefined>;

const ToolResultEnvelopeSchema = z.object({
  console: z.object({
    state: z.literal("ready"),
    message: z.string(),
    accessUrl: z.string().url()
  }).strict().optional(),
  warning: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.unknown()).optional()
  }).strict().optional()
}).strict();

/** 在业务 handler 之前统一执行一次进程级门控，并把单次通知附加到文本与结构化结果。 */
export class GatedMcpServer extends McpServer {
  private toolCallGate: ToolCallGate | undefined;

  public setToolCallGate(gate: ToolCallGate): void {
    this.toolCallGate = gate;
  }

  public override registerTool<
    OutputArgs extends ZodRawShapeCompat | AnySchema,
    InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined
  >(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: InputArgs;
      outputSchema?: OutputArgs;
      annotations?: Parameters<McpServer["registerTool"]>[1]["annotations"];
      _meta?: Record<string, unknown>;
    },
    callback: ToolCallback<InputArgs>
  ): RegisteredTool {
    const gatedCallback = (async (...args: Parameters<ToolCallback<InputArgs>>) => {
      const notice = await this.toolCallGate?.();
      const result = await Reflect.apply(callback, undefined, args) as CallToolResult;
      return notice === undefined ? result : appendNotice(result, notice);
    }) as ToolCallback<InputArgs>;
    const outputSchema = config.outputSchema instanceof z.ZodObject
      ? config.outputSchema.extend({ _sshMcp: ToolResultEnvelopeSchema.optional() })
      : config.outputSchema;
    return super.registerTool(name, { ...config, outputSchema } as typeof config, gatedCallback);
  }
}

function appendNotice(result: CallToolResult, notice: ToolCallNotice): CallToolResult {
  const envelope = notice.type === "console_ready"
    ? { console: { state: "ready" as const, message: notice.message, accessUrl: notice.accessUrl } }
    : { warning: { code: notice.code, message: notice.message, details: notice.details } };
  return {
    ...result,
    content: [
      { type: "text", text: JSON.stringify({ _sshMcp: envelope }) },
      ...(result.content ?? [])
    ],
    ...(result.structuredContent === undefined ? {} : {
      structuredContent: { ...result.structuredContent, _sshMcp: envelope }
    })
  };
}
