import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CommandRunner } from "../commands/command-runner.js";
import { createMcpOperationError, ErrorCodes, type McpOperationError } from "../errors/error-contract.js";
import { HostRegistry } from "../hosts/host-registry.js";
import { MultiHostCoordinator } from "../multihost/multi-host-coordinator.js";
import { OperationManagerError } from "../operations/operation-manager.js";
import { ProfileCompiler } from "../policy/profile-compiler.js";
import { PolicyEngine } from "../policy/policy-engine.js";
import { ProfileRemotePathVerifier } from "../policy/profile-remote-path-verifier.js";

const ProfileRunInputSchema = z.object({
  profileId: z.string().min(1),
  hosts: z.array(z.string().min(1)).min(1).max(10).refine((hosts) => new Set(hosts).size === hosts.length, "主机别名不可重复"),
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
  readonly coordinator?: MultiHostCoordinator;
  readonly pathVerifier?: ProfileRemotePathVerifier;
}

/** Profile 只能完整命中启动时规则；拒绝时不创建操作、不连接且不进入审批路径。 */
export function registerProfileRunTool(server: McpServer, dependencies: ProfileRunDependencies): void {
  const compiler = new ProfileCompiler();
  server.registerTool("profile_run", {
    description: "在 1–10 个完整匹配的登记主机执行预配置低风险 Profile",
    inputSchema: ProfileRunInputSchema,
    outputSchema: ProfileRunOutputSchema
  }, async ({ profileId, hosts, parameters, executionMode }) => {
    if (!dependencies.policy.hasProfile(profileId)) return errorResult(profileError(ErrorCodes.POLICY_NOT_FOUND));
    const registeredHosts = hosts.map((alias) => dependencies.registry.get(alias));
    if (registeredHosts.some((host) => host === undefined)) return errorResult(profileError(ErrorCodes.HOST_NOT_REGISTERED));
    const decisions = (registeredHosts as NonNullable<(typeof registeredHosts)[number]>[])
      .map((host) => ({ host, decision: dependencies.policy.evaluate({ profileId, host, parameters }) }));
    const denied = decisions.find(({ decision }) => !decision.matched);
    if (denied !== undefined && !denied.decision.matched) return errorResult(denied.decision.error);
    try {
      if (decisions.length === 1) {
        const first = decisions[0]!;
        if (!first.decision.matched) throw new Error("已验证的 Profile 匹配缺失");
        return successResult(dependencies.runner.start(
          first.host,
          compiler.compile(first.decision.match),
          undefined,
          (dependencies.pathVerifier ?? new ProfileRemotePathVerifier()).create(first.decision.match)
        ));
      }
      if (dependencies.coordinator === undefined) throw new Error("多主机协调器不可用");
      const commands = new Map(decisions.map(({ host, decision }) => {
        if (!decision.matched) throw new Error("已验证的 Profile 匹配缺失");
        return [host.alias, {
          command: compiler.compile(decision.match),
          preflight: (dependencies.pathVerifier ?? new ProfileRemotePathVerifier()).create(decision.match)
        }] as const;
      }));
      return successResult(dependencies.coordinator.start({
        hosts: decisions.map(({ host }) => host), executionMode: executionMode ?? "parallel", timeoutKind: "command",
        failureCode: ErrorCodes.COMMAND_FAILED, timeoutCode: ErrorCodes.COMMAND_TIMEOUT,
        start: (host) => {
          const selected = commands.get(host.alias)!;
          return dependencies.runner.start(host, selected.command, undefined, selected.preflight);
        }
      }));
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
