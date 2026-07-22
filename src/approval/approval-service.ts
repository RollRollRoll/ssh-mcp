import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ErrorCodes, createMcpOperationError, type McpOperationError } from "../errors/error-contract.js";
import {
  isVerifiedOperationIntent,
  type OperationIntent
} from "./operation-intent.js";
import { OperationManager, type OperationTimeoutKind } from "../operations/operation-manager.js";
import {
  ApprovalCoordinator,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  type ApprovalClient,
  type ApprovalClock,
  type ApprovalExecution,
  type ApprovalForm,
  type ApprovalResponse,
  type ApprovalRoute
} from "./approval-coordinator.js";

export {
  createApprovalForm,
  DEFAULT_APPROVAL_TIMEOUT_MS
} from "./approval-coordinator.js";
export type {
  ApprovalClient,
  ApprovalExecution,
  ApprovalForm,
  ApprovalResponse
} from "./approval-coordinator.js";
export type Clock = ApprovalClock;

export interface ApprovalExecutionContext {
  readonly operationId?: string;
  /** 后台运行器已经接管同一 Operation；审批服务不得把它提前结算为 completed。 */
  markBackground(): void;
}

export interface ApprovalExecutionOptions {
  readonly timeoutKind?: OperationTimeoutKind;
  readonly route?: ApprovalRoute;
}

export interface ApprovalResultEvent {
  readonly operationId?: string;
  readonly digest: string;
  readonly approved: boolean;
  readonly state: "completed" | McpOperationError["finalState"];
  readonly errorCode?: McpOperationError["code"];
}

/** 将 SDK 的已协商能力适配为可注入审批端口。 */
export class McpApprovalClient implements ApprovalClient {
  public constructor(private readonly server: Server) {}

  public supportsFormElicitation(): boolean {
    return this.server.getClientCapabilities()?.elicitation?.form !== undefined;
  }

  public async elicit(form: ApprovalForm, signal: AbortSignal): Promise<ApprovalResponse> {
    const response = await this.server.elicitInput({
      mode: form.mode,
      message: form.message,
      requestedSchema: form.requestedSchema
    }, {
      signal,
      timeout: form.timeoutMs,
      maxTotalTimeout: form.timeoutMs
    });
    return { action: response.action };
  }
}

/**
 * 所有副作用都经由本服务的回调门控；批准只用于当前调用，并且只会调用一次回调。
 */
export class ApprovalService {
  public readonly coordinator: ApprovalCoordinator;

  public constructor(
    private readonly client: ApprovalClient,
    clock: ApprovalClock = systemClock,
    private readonly timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS,
    private readonly operations?: OperationManager,
    private readonly onResult?: (event: ApprovalResultEvent) => void,
    coordinator?: ApprovalCoordinator
  ) {
    this.coordinator = coordinator ?? new ApprovalCoordinator({
      client: this.client,
      clock,
      approvalTimeoutMs: this.timeoutMs
    });
  }

  public async execute<T>(
    intent: OperationIntent,
    sideEffect: (approvedIntent: OperationIntent, context?: ApprovalExecutionContext) => T | Promise<T>,
    options: ApprovalExecutionOptions = {}
  ): Promise<ApprovalExecution<T>> {
    if (!isVerifiedOperationIntent(intent)) {
      return intentMismatchError();
    }
    const awaiting = this.operations?.create({
      initialState: "awaiting_approval",
      timeoutKind: "approval",
      approvalTimeoutManagedExternally: true,
      target: { hosts: intent.hosts }
    });
    const operationId = awaiting?.operationId;
    let background = false;
    let executionBegan = false;
    const execution = await this.coordinator.execute(intent, async (approvedIntent) => {
      executionBegan = true;
      if (operationId !== undefined) {
        this.operations!.start(operationId, undefined, undefined, options.timeoutKind ?? "command");
      }
      const context: ApprovalExecutionContext = Object.freeze({
        ...(operationId === undefined ? {} : { operationId }),
        markBackground: () => { background = true; }
      });
      const value = await sideEffect(approvedIntent, context);
      if (operationId !== undefined && !background) this.operations!.complete(operationId);
      return value;
    }, {
      route: options.route ?? "dual",
      ...(operationId === undefined ? {} : { operationId })
    });

    if (!execution.approved) {
      const error = operationId === undefined ? execution.error : withOperationId(execution.error, operationId);
      if (operationId !== undefined && !background) {
        if (error.finalState === "timed_out") this.operations!.timedOut(operationId, error);
        else if (executionBegan && error.finalState === "unknown") this.operations!.unknown(operationId, error);
        else this.operations!.fail(operationId, error);
      }
      this.publishResult({ operationId, digest: intent.digest, approved: false, state: error.finalState, errorCode: error.code });
      return { approved: false, error };
    }
    this.publishResult({ operationId, digest: intent.digest, approved: true, state: "completed" });
    return execution;
  }

  public shutdown(): void {
    this.coordinator.shutdown();
  }

  private publishResult(event: ApprovalResultEvent): void {
    try {
      this.onResult?.(event);
    } catch {
      // 结果观察者失败不能改变已经提交的审批和 Operation 终态。
    }
  }
}

const systemClock: ApprovalClock = {
  setTimeout: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  },
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
  now: () => Date.now()
};

function intentMismatchError(): { readonly approved: false; readonly error: McpOperationError } {
  return {
    approved: false,
    error: createMcpOperationError({
      code: ErrorCodes.APPROVAL_INTENT_MISMATCH,
      message: "操作意图完整性校验失败，未执行任何副作用",
      finalState: "failed",
      retriable: false,
      sideEffects: "none"
    })
  };
}

function withOperationId(error: McpOperationError, operationId: string): McpOperationError {
  return createMcpOperationError({ ...error, operationId }, undefined, { allowedOperationIds: new Set([operationId]) });
}
