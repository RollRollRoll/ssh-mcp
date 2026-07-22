import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import type { ConsoleClient } from "../src/console-client";
import type { ConsoleAction } from "../src/console-state";
import type { OperationOutput, RuntimeSnapshot } from "../src/console-types";

describe("控制台真实快照界面", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it("只渲染服务端快照，空状态明确且输出按纯文本显示", async () => {
    let dispatch!: React.Dispatch<ConsoleAction>;
    const client: ConsoleClient = {
      refresh: vi.fn(async () => undefined),
      close: vi.fn(),
      loadOutput: vi.fn(async (): Promise<OperationOutput> => ({
        frames: [{ stream: "stderr", cursor: 0, encoding: "utf8", data: "<script>危险文本</script>" }],
        nextCursor: 25, minCursor: 0, truncated: false, droppedBytes: 0
      })),
      previewCommand: vi.fn(async () => { throw new Error("未调用"); }),
      previewProfile: vi.fn(async () => { throw new Error("未调用"); }),
      decideApproval: vi.fn(async () => undefined)
    };
    ({ root, container } = render((nextDispatch) => { dispatch = nextDispatch; return client; }));
    expect(container.textContent).toContain("正在连接本机控制台");

    await act(async () => {
      dispatch({ type: "snapshot", snapshot: snapshot() });
    });
    expect(container.textContent).toContain("<host-safe>");
    expect(container.querySelector("host-safe")).toBeNull();
    expect(container.textContent).toContain("当前没有终端会话");
    expect(container.textContent).toContain("当前没有审批记录");

    const operation = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("operation-1"));
    await act(async () => operation?.click());
    expect(client.loadOutput).toHaveBeenCalledWith("operation-1", 0);
    expect(container.textContent).toContain("<script>危险文本</script>");
    expect(container.querySelector("script")).toBeNull();
  });

  it("断线时明确标记所有写能力禁用", async () => {
    let dispatch!: React.Dispatch<ConsoleAction>;
    ({ root, container } = render((nextDispatch) => {
      dispatch = nextDispatch;
      return {
        refresh: async () => undefined,
        loadOutput: async () => emptyOutput(),
        previewCommand: async () => { throw new Error("未调用"); },
        previewProfile: async () => { throw new Error("未调用"); },
        decideApproval: async () => undefined,
        close: () => undefined
      };
    }));
    await act(async () => dispatch({ type: "snapshot", snapshot: snapshot() }));
    expect(container.querySelector("main")?.dataset.writeEnabled).toBe("true");
    await act(async () => dispatch({ type: "disconnected" }));
    expect(container.querySelector("main")?.dataset.writeEnabled).toBe("false");
    expect(container.textContent).toContain("连接已断开（写操作已禁用）");
  });
});

function render(factory: (dispatch: React.Dispatch<ConsoleAction>) => ConsoleClient) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<App clientFactory={factory} />));
  return { root, container };
}

function snapshot(): RuntimeSnapshot {
  return {
    instanceId: "instance-alpha", revision: 3, serviceState: "active",
    hosts: [{
      alias: "<host-safe>", environment: "test", platform: "linux", shell: "posix",
      connectionState: "connected"
    }],
    operations: [{
      operationId: "operation-1", source: "mcp", kind: "command", hosts: ["<host-safe>"],
      state: "running", cancelRequested: false, lastStateChangeAt: 1, outputTruncated: false, progress: {}
    }],
    sessions: [], approvals: [], profiles: []
  };
}

function emptyOutput() {
  return { frames: [], nextCursor: 0, minCursor: 0, truncated: false, droppedBytes: 0 } as const;
}
