import type { ApprovalCoordinator } from "../approval/approval-coordinator.js";
import {
  type ConsoleOperationSummary,
  OperationManager
} from "../operations/operation-manager.js";
import { isTerminalOperationState } from "../operations/state-machine.js";

export type OperationCancelResult = Readonly<{
  status: "approval_cancelled" | "cancel_requested" | "terminal";
  operation: ConsoleOperationSummary;
}>;

/** 网页取消统一入口：待审批项由仲裁器结算，运行项沿用既有停止确认状态机。 */
export class OperationControlService {
  public constructor(
    private readonly approvals: ApprovalCoordinator,
    private readonly operations: OperationManager
  ) {}

  public cancel(operationId: string): OperationCancelResult {
    const pendingApproval = this.approvals.list().find((approval) =>
      approval.operationId === operationId && approval.state === "pending");
    if (pendingApproval !== undefined) {
      this.approvals.settle(pendingApproval.approvalId, "cancel", "web");
      return Object.freeze({
        status: "approval_cancelled",
        operation: this.operations.describeForConsole(operationId)
      });
    }

    const before = this.operations.describeForConsole(operationId);
    if (isTerminalOperationState(before.state)) {
      return Object.freeze({ status: "terminal", operation: before });
    }
    this.operations.cancel(operationId);
    const operation = this.operations.describeForConsole(operationId);
    return Object.freeze({
      status: isTerminalOperationState(operation.state) ? "terminal" : "cancel_requested",
      operation
    });
  }
}
