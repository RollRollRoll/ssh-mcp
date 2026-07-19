import type { ElicitRequestFormParams } from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ErrorCodes, createMcpOperationError, type McpOperationError } from "../errors/error-contract.js";
import {
  consumeVerifiedOperationIntent,
  isVerifiedOperationIntent,
  type OperationIntent
} from "./operation-intent.js";
import { OperationManager, type OperationTimeoutKind } from "../operations/operation-manager.js";

export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;

export interface Clock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

export interface ApprovalForm {
  readonly mode: "form";
  readonly message: string;
  readonly requestedSchema: ElicitRequestFormParams["requestedSchema"];
  readonly timeoutMs: number;
}

export interface ApprovalResponse {
  readonly action: "accept" | "decline" | "cancel";
}

export interface ApprovalClient {
  supportsFormElicitation(): boolean;
  elicit(form: ApprovalForm, signal: AbortSignal): Promise<ApprovalResponse>;
}

export type ApprovalExecution<T> =
  | { readonly approved: true; readonly intent: OperationIntent; readonly value: T }
  | { readonly approved: false; readonly error: McpOperationError };

export interface ApprovalExecutionContext {
  readonly operationId?: string;
  /** 后台运行器已经接管同一 Operation；审批服务不得把它提前结算为 completed。 */
  markBackground(): void;
}

export interface ApprovalExecutionOptions {
  readonly timeoutKind?: OperationTimeoutKind;
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
  private readonly pendingControllers = new Set<AbortController>();
  private shuttingDown = false;

  public constructor(
    private readonly client: ApprovalClient,
    private readonly clock: Clock = systemClock,
    private readonly timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS,
    private readonly operations?: OperationManager,
    private readonly onResult?: (event: ApprovalResultEvent) => void
  ) {}

  public async execute<T>(
    intent: OperationIntent,
    sideEffect: (approvedIntent: OperationIntent, context?: ApprovalExecutionContext) => T | Promise<T>,
    options: ApprovalExecutionOptions = {}
  ): Promise<ApprovalExecution<T>> {
    if (!isVerifiedOperationIntent(intent)) {
      return intentMismatchError();
    }
    if (this.shuttingDown) return { approved: false, error: approvalError(ErrorCodes.APPROVAL_DECLINED, "failed", "disconnected") };
    const awaiting = this.operations?.create({
      initialState: "awaiting_approval",
      timeoutKind: "approval",
      approvalTimeoutManagedExternally: true,
      target: { hosts: intent.hosts }
    });
    const operationId = awaiting?.operationId;
    const approvalFailure = await this.requestApproval(intent);
    if (approvalFailure !== undefined) {
      const error = operationId === undefined ? approvalFailure : withOperationId(approvalFailure, operationId);
      if (operationId !== undefined) {
        if (error.finalState === "timed_out") this.operations!.timedOut(operationId, error);
        else this.operations!.fail(operationId, error);
      }
      this.onResult?.({ operationId, digest: intent.digest, approved: false, state: error.finalState, errorCode: error.code });
      return { approved: false, error };
    }
    if (!consumeVerifiedOperationIntent(intent)) {
      const mismatch = intentMismatchError();
      if (operationId === undefined) return mismatch;
      const error = withOperationId(mismatch.error, operationId);
      this.operations!.fail(operationId, error);
      this.onResult?.({ operationId, digest: intent.digest, approved: false, state: "failed", errorCode: error.code });
      return { approved: false, error };
    }
    if (operationId !== undefined) this.operations!.start(operationId, undefined, undefined, options.timeoutKind ?? "command");
    let background = false;
    const context: ApprovalExecutionContext = Object.freeze({
      ...(operationId === undefined ? {} : { operationId }),
      markBackground: () => { background = true; }
    });
    try {
      const value = await sideEffect(intent, context);
      if (operationId !== undefined && !background) this.operations!.complete(operationId);
      this.onResult?.({ operationId, digest: intent.digest, approved: true, state: "completed" });
      return { approved: true, intent, value };
    } catch (error: unknown) {
      if (operationId !== undefined && !background) {
        // 已进入批准后的执行阶段；任意异常都不能再宣称副作用为零。
        this.operations!.unknown(operationId, createMcpOperationError({
          code: ErrorCodes.STATE_UNKNOWN,
          message: ErrorCodes.STATE_UNKNOWN,
          finalState: "unknown",
          retriable: false,
          sideEffects: "possible",
          operationId
        }, undefined, { allowedOperationIds: new Set([operationId]) }));
      }
      throw error;
    }
  }

  public shutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const controller of this.pendingControllers) controller.abort();
    this.pendingControllers.clear();
  }

  private async requestApproval(intent: OperationIntent): Promise<McpOperationError | undefined> {
    if (!this.client.supportsFormElicitation()) {
      return approvalError(ErrorCodes.APPROVAL_UNSUPPORTED, "failed");
    }

    const controller = new AbortController();
    this.pendingControllers.add(controller);
    let timer: unknown;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = this.clock.setTimeout(() => {
        resolve("timeout");
        controller.abort();
      }, this.timeoutMs);
    });
    const interrupted = new Promise<"shutdown">((resolve) => {
      controller.signal.addEventListener("abort", () => resolve("shutdown"), { once: true });
    });

    try {
      const response = await Promise.race<ApprovalResponse | "timeout" | "shutdown">([
        this.client.elicit(createApprovalForm(intent, this.timeoutMs), controller.signal),
        timeout,
        interrupted
      ]);
      if (response === "timeout") {
        return approvalError(ErrorCodes.APPROVAL_TIMEOUT, "timed_out");
      }
      if (response === "shutdown") {
        return approvalError(ErrorCodes.APPROVAL_DECLINED, "failed", "disconnected");
      }
      if (response.action === "accept") {
        return undefined;
      }
      if (response.action === "cancel") {
        return approvalError(ErrorCodes.APPROVAL_DECLINED, "failed", "cancelled");
      }
      return approvalError(ErrorCodes.APPROVAL_DECLINED, "failed");
    } catch {
      return approvalError(ErrorCodes.APPROVAL_DECLINED, "failed", "disconnected");
    } finally {
      this.clock.clearTimeout(timer);
      this.pendingControllers.delete(controller);
    }
  }
}

export function createApprovalForm(intent: OperationIntent, timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS): ApprovalForm {
  return Object.freeze({
    mode: "form" as const,
    message: [
      "操作授权请求",
      `目标主机（按顺序）：${JSON.stringify(intent.hosts)}`,
      `主机平台：${JSON.stringify(intent.platformByHost)}`,
      "完整操作（canonical JSON）：",
      intent.canonicalJson,
      `SHA-256 摘要：${intent.digest}`,
      "仅接受会执行该精确操作一次；拒绝、取消、超时或断链均不会执行。"
    ].join("\n"),
    requestedSchema: { type: "object", properties: {} } as ElicitRequestFormParams["requestedSchema"],
    timeoutMs
  });
}

const systemClock: Clock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout)
};

function approvalError(
  code: typeof ErrorCodes.APPROVAL_UNSUPPORTED | typeof ErrorCodes.APPROVAL_DECLINED | typeof ErrorCodes.APPROVAL_TIMEOUT,
  finalState: "failed" | "timed_out",
  reason?: "cancelled" | "disconnected"
): McpOperationError {
  return createMcpOperationError({
    code,
    message: "操作未获审批，未执行任何副作用",
    finalState,
    retriable: false,
    sideEffects: "none",
    ...(reason === undefined ? {} : { details: { reason } })
  });
}

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
