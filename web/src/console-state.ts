import type { ConnectionState, OperationOutput, RuntimeSnapshot } from "./console-types";

export interface ConsoleState {
  readonly connection: ConnectionState;
  readonly snapshot?: RuntimeSnapshot;
  readonly selectedOperationId?: string;
  readonly output?: OperationOutput;
}

export type ConsoleAction =
  | { readonly type: "ready" }
  | { readonly type: "syncing" }
  | { readonly type: "snapshot"; readonly snapshot: RuntimeSnapshot }
  | { readonly type: "disconnected" }
  | { readonly type: "select-operation"; readonly operationId: string }
  | {
    readonly type: "output";
    readonly operationId: string;
    readonly requestedCursor: number;
    readonly output: OperationOutput;
  };

export const initialConsoleState: ConsoleState = Object.freeze({ connection: "connecting" });

/** 服务端快照是唯一事实源；较旧响应不能覆盖较新修订。 */
export function consoleReducer(state: ConsoleState, action: ConsoleAction): ConsoleState {
  switch (action.type) {
    case "ready":
    case "syncing":
      return { ...state, connection: "syncing" };
    case "disconnected":
      return { ...state, connection: "disconnected" };
    case "snapshot":
      if (state.snapshot !== undefined && action.snapshot.revision < state.snapshot.revision) return state;
      return {
        ...state,
        connection: "online",
        snapshot: action.snapshot,
        ...(state.selectedOperationId !== undefined
          && action.snapshot.operations.some((item) => item.operationId === state.selectedOperationId)
          ? {} : { selectedOperationId: undefined, output: undefined })
      };
    case "select-operation":
      return { ...state, selectedOperationId: action.operationId, output: undefined };
    case "output":
      if (state.selectedOperationId !== action.operationId) return state;
      if (state.output === undefined || state.output.nextCursor !== action.requestedCursor
        || action.output.truncated) {
        return { ...state, output: action.output };
      }
      return {
        ...state,
        output: {
          ...action.output,
          frames: [...state.output.frames, ...action.output.frames],
          truncated: state.output.truncated || action.output.truncated,
          droppedBytes: state.output.droppedBytes + action.output.droppedBytes
        }
      };
  }
}

export function writesEnabled(state: ConsoleState): boolean {
  return state.connection === "online" && state.snapshot?.serviceState === "active";
}
