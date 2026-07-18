export type OperationState =
  | "awaiting_approval"
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "partial_failure"
  | "unknown";

const transitions: Readonly<Record<OperationState, readonly OperationState[]>> = {
  awaiting_approval: ["running", "failed"],
  running: ["completed", "failed", "timed_out", "cancelled", "partial_failure", "unknown"],
  completed: [],
  failed: [],
  timed_out: [],
  cancelled: [],
  partial_failure: [],
  unknown: []
};

export class OperationTransitionError extends Error {
  public constructor(readonly from: OperationState, readonly to: OperationState) {
    super(`非法操作状态转换：${from} -> ${to}`);
    this.name = "OperationTransitionError";
  }
}

export function isTerminalOperationState(state: OperationState): boolean {
  switch (state) {
    case "completed":
    case "failed":
    case "timed_out":
    case "cancelled":
    case "partial_failure":
    case "unknown":
      return true;
    case "awaiting_approval":
    case "running":
      return false;
  }
}

export function canTransition(from: OperationState, to: OperationState): boolean {
  return transitions[from].includes(to);
}

export class OperationStateMachine {
  public constructor(private current: OperationState) {}

  public get state(): OperationState {
    return this.current;
  }

  public transition(to: OperationState): OperationState {
    if (!canTransition(this.current, to)) {
      throw new OperationTransitionError(this.current, to);
    }
    this.current = to;
    return this.current;
  }
}
