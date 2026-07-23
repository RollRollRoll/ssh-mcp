import {
  McpServer,
  type RegisteredTool,
  type ToolCallback
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface ToolCallNotice {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type ToolCallGate = () => Promise<ToolCallNotice | undefined>;

/** 在业务 handler 之前统一执行一次进程级门控，并把非阻塞告警附加到工具文本结果。 */
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
    return super.registerTool(name, config, gatedCallback);
  }
}

function appendNotice(result: CallToolResult, notice: ToolCallNotice): CallToolResult {
  return {
    ...result,
    content: [
      ...(result.content ?? []),
      { type: "text", text: JSON.stringify({ warning: notice }) }
    ]
  };
}
