import type { ElicitRequestFormParams } from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ErrorCodes, createMcpOperationError, type McpOperationError } from "../errors/error-contract.js";
import {
  consumeVerifiedOperationIntent,
  isVerifiedOperationIntent,
  type OperationIntent
} from "./operation-intent.js";

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
  public constructor(
    private readonly client: ApprovalClient,
    private readonly clock: Clock = systemClock,
    private readonly timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS
  ) {}

  public async execute<T>(
    intent: OperationIntent,
    sideEffect: (approvedIntent: OperationIntent) => T | Promise<T>
  ): Promise<ApprovalExecution<T>> {
    if (!isVerifiedOperationIntent(intent)) {
      return intentMismatchError();
    }
    const approvalFailure = await this.requestApproval(intent);
    if (approvalFailure !== undefined) {
      return { approved: false, error: approvalFailure };
    }
    if (!consumeVerifiedOperationIntent(intent)) {
      return intentMismatchError();
    }

    const value = await sideEffect(intent);
    return { approved: true, intent, value };
  }

  private async requestApproval(intent: OperationIntent): Promise<McpOperationError | undefined> {
    if (!this.client.supportsFormElicitation()) {
      return approvalError(ErrorCodes.APPROVAL_UNSUPPORTED, "failed");
    }

    const controller = new AbortController();
    let timer: unknown;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = this.clock.setTimeout(() => {
        resolve("timeout");
        controller.abort();
      }, this.timeoutMs);
    });

    try {
      const response = await Promise.race<ApprovalResponse | "timeout">([
        this.client.elicit(createApprovalForm(intent, this.timeoutMs), controller.signal),
        timeout
      ]);
      if (response === "timeout") {
        return approvalError(ErrorCodes.APPROVAL_TIMEOUT, "timed_out");
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

function intentMismatchError(): ApprovalExecution<never> {
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
