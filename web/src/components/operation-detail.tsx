import type { ConsoleOperation } from "../console-types";

const cancellable = new Set(["awaiting_approval", "running"]);

export function OperationDetail({ operation, disabled, cancelPending, onCancel }: {
  readonly operation: ConsoleOperation;
  readonly disabled: boolean;
  readonly cancelPending: boolean;
  readonly onCancel: () => void;
}) {
  return (
    <div className="operation-control">
      <span>真实状态：{operationLabel(operation.state)}</span>
      {cancellable.has(operation.state) && <button type="button" disabled={disabled || cancelPending}
        onClick={onCancel}>{cancelPending || operation.cancelRequested ? "已请求取消" : "请求取消操作"}</button>}
    </div>
  );
}

function operationLabel(state: string): string {
  return ({
    awaiting_approval: "等待审批", running: "运行中", completed: "已完成", failed: "失败",
    timed_out: "已超时", cancelled: "已取消", partial_failure: "部分失败", unknown: "状态未知"
  } as Record<string, string>)[state] ?? state;
}
