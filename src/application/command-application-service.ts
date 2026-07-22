import type {
  ApprovalExecution,
  ApprovalExecutionContext,
  ApprovalExecutionOptions,
  ApprovalOperationRequest
} from "../approval/approval-service.js";
import { createOperationIntent, type OperationIntent } from "../approval/operation-intent.js";
import { CommandRunner } from "../commands/command-runner.js";
import { ErrorCodes, createMcpOperationError, type McpOperationError } from "../errors/error-contract.js";
import { HostRegistry } from "../hosts/host-registry.js";
import { MultiHostCoordinator, type MultiHostExecutionMode } from "../multihost/multi-host-coordinator.js";
import type { OperationSnapshot } from "../operations/operation-manager.js";
import type { ApprovalSafeSnapshot } from "../approval/approval-coordinator.js";

export interface CommandApplicationInput {
  readonly source: "mcp" | "web";
  readonly hosts: readonly string[];
  readonly command: string;
  readonly executionMode?: MultiHostExecutionMode;
}

export interface CommandPreview {
  readonly approvalId: string;
  readonly operationId?: string;
  readonly intent: OperationIntent;
  readonly approval: ApprovalSafeSnapshot;
  readonly result: Promise<ApprovalExecution<OperationSnapshot>>;
}

export interface CommandApprovalPort {
  execute<T>(intent: OperationIntent, sideEffect: (
    approvedIntent: OperationIntent,
    context?: ApprovalExecutionContext
  ) => T | Promise<T>, options?: ApprovalExecutionOptions): Promise<ApprovalExecution<T>>;
  request?<T>(intent: OperationIntent, sideEffect: (
    approvedIntent: OperationIntent,
    context?: ApprovalExecutionContext
  ) => T | Promise<T>, options?: ApprovalExecutionOptions): ApprovalOperationRequest<T>;
  getApproval?(approvalId: string): ApprovalSafeSnapshot | undefined;
}

interface PreparedCommand {
  readonly intent: OperationIntent;
  readonly hosts: readonly NonNullable<ReturnType<HostRegistry["get"]>>[];
  readonly route: "dual" | "web_only";
  readonly source: "mcp" | "web";
}

/** MCP 与网页命令共用主机解析、Intent、审批及 CommandRunner 启动路径。 */
export class CommandApplicationService {
  public constructor(
    private readonly registry: HostRegistry,
    private readonly approval: CommandApprovalPort,
    private readonly runner: CommandRunner,
    private readonly coordinator?: MultiHostCoordinator
  ) {}

  public async execute(input: CommandApplicationInput): Promise<ApprovalExecution<OperationSnapshot>> {
    const prepared = this.prepare(input);
    if (prepared instanceof ApplicationServiceError) return { approved: false, error: prepared.error };
    return await this.approval.execute(
      prepared.intent,
      (approved, context) => this.startApproved(prepared, approved, context),
      { timeoutKind: "command", route: prepared.route }
    );
  }

  public preview(input: { readonly host: string; readonly command: string }): CommandPreview {
    const prepared = this.prepare({ ...input, source: "web", hosts: [input.host] });
    if (prepared instanceof ApplicationServiceError) throw prepared;
    if (this.approval.request === undefined || this.approval.getApproval === undefined) {
      throw new Error("审批端口不支持网页预览");
    }
    const request = this.approval.request(
      prepared.intent,
      (approved, context) => this.startApproved(prepared, approved, context),
      { timeoutKind: "command", route: "web_only" }
    );
    const approval = this.approval.getApproval(request.approvalId);
    if (approval === undefined) {
      throw new ApplicationServiceError(applicationError(ErrorCodes.RESOURCE_LIMIT));
    }
    return Object.freeze({
      approvalId: request.approvalId,
      ...(request.operationId === undefined ? {} : { operationId: request.operationId }),
      intent: prepared.intent,
      approval,
      result: request.result
    });
  }

  private prepare(input: CommandApplicationInput): PreparedCommand | ApplicationServiceError {
    if (input.command.trim().length === 0 || input.hosts.length < 1 || input.hosts.length > 10
      || new Set(input.hosts).size !== input.hosts.length || (input.source === "web" && input.hosts.length !== 1)) {
      return new ApplicationServiceError(applicationError(ErrorCodes.INVALID_ARGUMENT));
    }
    const hosts = input.hosts.map((alias) => this.registry.get(alias));
    if (hosts.some((host) => host === undefined)) {
      return new ApplicationServiceError(applicationError(ErrorCodes.HOST_NOT_REGISTERED));
    }
    const registered = hosts as PreparedCommand["hosts"];
    return Object.freeze({
      hosts: Object.freeze([...registered]),
      source: input.source,
      route: input.source === "web" ? "web_only" : "dual",
      intent: createOperationIntent({
        kind: "raw_command",
        hosts: input.hosts,
        platformByHost: Object.fromEntries(registered.map((host) => [host.alias, host.platform])),
        payload: { command: input.command },
        executionMode: input.executionMode ?? "parallel"
      })
    });
  }

  private startApproved(
    prepared: PreparedCommand,
    approved: OperationIntent,
    context?: ApprovalExecutionContext
  ): OperationSnapshot {
    if (!sameIntent(prepared.intent, approved) || typeof approved.payload.command !== "string") {
      throw new ApplicationServiceError(applicationError(ErrorCodes.APPROVAL_INTENT_MISMATCH));
    }
    const command = approved.payload.command;
    let snapshot: OperationSnapshot;
    if (prepared.hosts.length === 1) {
      snapshot = this.runner.start(
        prepared.hosts[0]!, command, context?.operationId, undefined,
        prepared.route, "command", prepared.source
      );
    } else {
      if (this.coordinator === undefined) throw new Error("多主机协调器不可用");
      snapshot = this.coordinator.start({
        hosts: prepared.hosts,
        executionMode: approved.executionMode ?? "parallel",
        timeoutKind: "command",
        failureCode: ErrorCodes.COMMAND_FAILED,
        timeoutCode: ErrorCodes.COMMAND_TIMEOUT,
        operationKind: "command",
        source: prepared.source,
        start: (host) => this.runner.start(host, command, undefined, undefined, prepared.route, "command", prepared.source)
      }, context?.operationId);
    }
    context?.markBackground();
    return snapshot;
  }
}

export class ApplicationServiceError extends Error {
  public constructor(readonly error: McpOperationError) {
    super(error.message);
    this.name = "ApplicationServiceError";
  }
}

function sameIntent(expected: OperationIntent, approved: OperationIntent): boolean {
  return expected.kind === approved.kind
    && expected.digest === approved.digest
    && expected.canonicalJson === approved.canonicalJson;
}

function applicationError(code: McpOperationError["code"]): McpOperationError {
  return createMcpOperationError({ code, message: code, finalState: "failed", retriable: false, sideEffects: "none" });
}
