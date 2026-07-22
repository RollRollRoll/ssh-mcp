import type { ApprovalExecution, ApprovalOperationRequest, ApprovalService } from "../approval/approval-service.js";
import { createOperationIntent, type JsonValue, type OperationIntent } from "../approval/operation-intent.js";
import { CommandRunner } from "../commands/command-runner.js";
import { ErrorCodes, createMcpOperationError, type McpOperationError } from "../errors/error-contract.js";
import { HostRegistry } from "../hosts/host-registry.js";
import { MultiHostCoordinator, type MultiHostExecutionMode } from "../multihost/multi-host-coordinator.js";
import type { OperationSnapshot } from "../operations/operation-manager.js";
import { ProfileCompiler } from "../policy/profile-compiler.js";
import { PolicyEngine, type VerifiedProfileMatch } from "../policy/policy-engine.js";
import { ProfileRemotePathVerifier } from "../policy/profile-remote-path-verifier.js";
import type { ApprovalSafeSnapshot } from "../approval/approval-coordinator.js";
import type { LowRiskParameter } from "../config/schema.js";
import { ApplicationServiceError } from "./command-application-service.js";

export interface ProfileApplicationInput {
  readonly profileId: string;
  readonly hosts: readonly string[];
  readonly parameters: unknown;
  readonly executionMode?: MultiHostExecutionMode;
}

export interface ProfilePreview {
  readonly approvalId: string;
  readonly operationId?: string;
  readonly intent: OperationIntent;
  readonly approval: ApprovalSafeSnapshot;
  readonly result: Promise<ApprovalExecution<OperationSnapshot>>;
}

export interface ConsoleProfileSummary {
  readonly id: string;
  readonly platform: "linux" | "windows";
  readonly hostAliases: readonly string[];
  readonly parameters: readonly LowRiskParameter[];
}

interface PreparedProfile {
  readonly matches: readonly VerifiedProfileMatch[];
  readonly commands: ReadonlyMap<string, string>;
}

/** MCP 保持低风险自动执行；网页在同一规则匹配与编译结果上增加 web_only 审批。 */
export class ProfileApplicationService {
  private readonly compiler = new ProfileCompiler();

  public constructor(
    private readonly registry: HostRegistry,
    private readonly policy: PolicyEngine,
    private readonly runner: CommandRunner,
    private readonly approval?: ApprovalService,
    private readonly coordinator?: MultiHostCoordinator,
    private readonly pathVerifier = new ProfileRemotePathVerifier()
  ) {}

  public list(): readonly ConsoleProfileSummary[] {
    return Object.freeze(this.policy.profiles().map((profile) => Object.freeze({
      id: profile.id,
      platform: profile.platform,
      hostAliases: Object.freeze([...profile.hostAliases]),
      parameters: Object.freeze(profile.parameters.map((parameter) => freezeClone(parameter)))
    })).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  }

  public runMcp(input: ProfileApplicationInput): OperationSnapshot | McpOperationError {
    const prepared = this.prepare(input);
    if (prepared instanceof ApplicationServiceError) return prepared.error;
    if (prepared.matches.length === 1) {
      const match = prepared.matches[0]!;
      return this.runner.start(
        match.host, prepared.commands.get(match.host.alias)!, undefined,
        this.pathVerifier.create(match), "dual", "profile", "mcp"
      );
    }
    if (this.coordinator === undefined) throw new Error("多主机协调器不可用");
    return this.coordinator.start({
      hosts: prepared.matches.map((match) => match.host),
      executionMode: input.executionMode ?? "parallel",
      timeoutKind: "command",
      failureCode: ErrorCodes.COMMAND_FAILED,
      timeoutCode: ErrorCodes.COMMAND_TIMEOUT,
      operationKind: "profile",
      source: "mcp",
      start: (host) => {
        const match = prepared.matches.find((candidate) => candidate.host.alias === host.alias)!;
        return this.runner.start(
          host, prepared.commands.get(host.alias)!, undefined,
          this.pathVerifier.create(match), "dual", "profile", "mcp"
        );
      }
    });
  }

  public preview(input: {
    readonly host: string;
    readonly profileId: string;
    readonly parameters: unknown;
  }): ProfilePreview {
    if (this.approval === undefined) throw new Error("审批服务不可用");
    const prepared = this.prepare({ ...input, hosts: [input.host] });
    if (prepared instanceof ApplicationServiceError) throw prepared;
    const match = prepared.matches[0]!;
    const command = prepared.commands.get(match.host.alias)!;
    const parameters = Object.fromEntries(match.values.map(({ parameter, value }) => [parameter.name, value])) as Record<string, JsonValue>;
    const intent = createOperationIntent({
      kind: "profile",
      hosts: [match.host.alias],
      platformByHost: { [match.host.alias]: match.host.platform },
      payload: { profileId: input.profileId, parameters, command }
    });
    const request: ApprovalOperationRequest<OperationSnapshot> = this.approval.request(intent, (approved, context) => {
      if (!sameIntent(intent, approved) || approved.payload.command !== command) {
        throw new ApplicationServiceError(profileError(ErrorCodes.APPROVAL_INTENT_MISMATCH));
      }
      const snapshot = this.runner.start(
        match.host, command, context?.operationId, this.pathVerifier.create(match),
        "web_only", "profile", "web"
      );
      context?.markBackground();
      return snapshot;
    }, { timeoutKind: "command", route: "web_only" });
    const approval = this.approval.getApproval(request.approvalId);
    if (approval === undefined) throw new Error("网页审批记录未创建");
    return Object.freeze({
      approvalId: request.approvalId,
      ...(request.operationId === undefined ? {} : { operationId: request.operationId }),
      intent,
      approval,
      result: request.result
    });
  }

  private prepare(input: ProfileApplicationInput): PreparedProfile | ApplicationServiceError {
    if (!this.policy.hasProfile(input.profileId)) return new ApplicationServiceError(profileError(ErrorCodes.POLICY_NOT_FOUND));
    if (input.hosts.length < 1 || input.hosts.length > 10 || new Set(input.hosts).size !== input.hosts.length) {
      return new ApplicationServiceError(profileError(ErrorCodes.INVALID_ARGUMENT));
    }
    const hosts = input.hosts.map((alias) => this.registry.get(alias));
    if (hosts.some((host) => host === undefined)) return new ApplicationServiceError(profileError(ErrorCodes.HOST_NOT_REGISTERED));
    const decisions = (hosts as NonNullable<(typeof hosts)[number]>[])
      .map((host) => this.policy.evaluate({ profileId: input.profileId, host, parameters: input.parameters }));
    const denied = decisions.find((decision) => !decision.matched);
    if (denied !== undefined && !denied.matched) return new ApplicationServiceError(denied.error);
    const matches = decisions.map((decision) => {
      if (!decision.matched) throw new Error("已验证的 Profile 匹配缺失");
      return decision.match;
    });
    return Object.freeze({
      matches: Object.freeze(matches),
      commands: new Map(matches.map((match) => [match.host.alias, this.compiler.compile(match)]))
    });
  }
}

function sameIntent(expected: OperationIntent, approved: OperationIntent): boolean {
  return expected.digest === approved.digest && expected.canonicalJson === approved.canonicalJson;
}

function profileError(code: McpOperationError["code"]): McpOperationError {
  return createMcpOperationError({ code, message: code, finalState: "failed", retriable: false, sideEffects: "none" });
}

function freezeClone<T>(value: T): T {
  const clone = structuredClone(value);
  freezeRecursively(clone);
  return clone;
}

function freezeRecursively(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value)) freezeRecursively(child);
  Object.freeze(value);
}
