import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CommandRunner } from "../commands/command-runner.js";
import { createMcpOperationError, ErrorCodes, type McpOperationError } from "../errors/error-contract.js";
import { HostRegistry } from "../hosts/host-registry.js";
import { OperationManagerError } from "../operations/operation-manager.js";
import { ProfileCompiler } from "../policy/profile-compiler.js";
import { PolicyEngine } from "../policy/policy-engine.js";

const ProfileRunInputSchema = z.object({
  profileId: z.string().min(1),
  hosts: z.array(z.string().min(1)).length(1).refine((hosts) => new Set(hosts).size === hosts.length, "主机别名不可重复"),
  parameters: z.record(z.unknown()),
  executionMode: z.enum(["parallel", "sequential"]).optional()
}).strict();
const ProfileErrorSchema = z.object({
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
const ProfileRunOutputSchema = z.object({
  operationId: z.string().optional(),
  state: z.literal("running").optional(),
  error: ProfileErrorSchema.optional()
}).strict();

export interface ProfileRunDependencies {
  readonly registry: HostRegistry;
  readonly runner: CommandRunner;
  readonly policy: PolicyEngine;
}

/** Profile 只能完整命中启动时规则；拒绝时不创建操作、不连接且不进入审批路径。 */
export function registerProfileRunTool(server: McpServer, dependencies: ProfileRunDependencies): void {
  const compiler = new ProfileCompiler();
  server.registerTool("profile_run", {
    description: "执行完整匹配的预配置低风险 Profile",
    inputSchema: ProfileRunInputSchema,
    outputSchema: ProfileRunOutputSchema
  }, async ({ profileId, hosts, parameters, executionMode }) => {
    void executionMode;
    if (!dependencies.policy.hasProfile(profileId)) return errorResult(profileError(ErrorCodes.POLICY_NOT_FOUND));
    const host = dependencies.registry.get(hosts[0]!);
    if (host === undefined) return errorResult(profileError(ErrorCodes.HOST_NOT_REGISTERED));
    const decision = dependencies.policy.evaluate({ profileId, host, parameters });
    if (!decision.matched) return errorResult(decision.error);
    try {
      return successResult(dependencies.runner.start(host, compiler.compile(decision.match)));
    } catch (error: unknown) {
      if (error instanceof OperationManagerError) return errorResult(error.error);
      throw error;
    }
  });
}

function profileError(code: McpOperationError["code"]): McpOperationError {
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
