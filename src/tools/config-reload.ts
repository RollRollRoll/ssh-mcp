import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ConfigError } from "../config/loader.js";
import {
  ConfigRestartRequiredError,
  type ConfigReloadSnapshot
} from "../config/runtime-config.js";
import { createMcpOperationError, ErrorCodes, type McpOperationError } from "../errors/error-contract.js";

const ConfigReloadInputSchema = z.object({}).strict();
const ConfigReloadErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  finalState: z.enum(["failed", "timed_out", "partial_failure", "unknown"]),
  retriable: z.boolean(),
  sideEffects: z.enum(["none", "possible", "partial", "confirmed"])
}).strict();
const ConfigReloadOutputSchema = z.object({
  reloaded: z.boolean(),
  hostCount: z.number().int().min(1).optional(),
  profileCount: z.number().int().min(0).optional(),
  error: ConfigReloadErrorSchema.optional()
}).strict();

export interface ConfigReloadDependencies {
  reload(): ConfigReloadSnapshot;
}

export function registerConfigReloadTool(server: McpServer, dependencies: ConfigReloadDependencies): void {
  server.registerTool("config_reload", {
    description: "重新读取启动 YAML，并原子更新登记主机与低风险 Profile；其他字段变更需要重启服务",
    inputSchema: ConfigReloadInputSchema,
    outputSchema: ConfigReloadOutputSchema
  }, () => {
    try {
      const snapshot = dependencies.reload();
      const structuredContent = { reloaded: true as const, ...snapshot };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
        structuredContent
      };
    } catch (error: unknown) {
      const operationError = reloadError(error);
      if (operationError === undefined) throw error;
      const structuredContent = { reloaded: false as const, error: operationError };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
        structuredContent,
        isError: true as const
      };
    }
  });
}

function reloadError(error: unknown): McpOperationError | undefined {
  if (!(error instanceof ConfigError) && !(error instanceof ConfigRestartRequiredError)) return undefined;
  const restartRequired = error instanceof ConfigRestartRequiredError;
  const code = restartRequired ? ErrorCodes.CONFIG_RESTART_REQUIRED : ErrorCodes.CONFIG_INVALID;
  return createMcpOperationError({
    code,
    message: code,
    finalState: "failed",
    retriable: error instanceof ConfigError,
    sideEffects: "none"
  });
}
