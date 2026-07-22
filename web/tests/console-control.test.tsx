import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import type { ConsoleClient } from "../src/console-client";
import type { ConsoleAction } from "../src/console-state";
import type { ConsoleOperation, OperationCancelResponse, RuntimeSnapshot } from "../src/console-types";
import { testWithIds } from "../../tests/test-with-ids.js";

describe("控制台审批、取消与键盘流程", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  testWithIds(["LC-SC-048", "LC-SC-050", "LC-AC-010"],
    "双通道审批显示完整纯文本，圈定焦点，Escape 取消并恢复触发按钮", async () => {
    let dispatch!: React.Dispatch<ConsoleAction>;
    const client = mockClient();
    ({ root, container } = render((next) => { dispatch = next; return client; }));
    await act(async () => dispatch({ type: "snapshot", snapshot: snapshot() }));
    const trigger = button(container, "approval-1");
    act(() => { trigger.focus(); trigger.click(); });
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("MCP 与网页双通道");
    expect(dialog.textContent).toContain("<script>中文</script>");
    expect(dialog.querySelector("script")).toBeNull();
    expect(document.activeElement?.textContent).toContain("取消");

    act(() => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Tab", shiftKey: true, bubbles: true, cancelable: true
    })));
    expect(document.activeElement?.textContent).toContain("接受并执行一次");
    await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape", bubbles: true, cancelable: true
    })));
    expect(client.decideApproval).toHaveBeenCalledWith("approval-1", "cancel", "a".repeat(64));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("后到决定明确提示已由其他通道处理", async () => {
    let dispatch!: React.Dispatch<ConsoleAction>;
    const client = mockClient({
      decideApproval: vi.fn(async () => { throw new Error("APPROVAL_ALREADY_RESOLVED"); })
    });
    ({ root, container } = render((next) => { dispatch = next; return client; }));
    await act(async () => dispatch({ type: "snapshot", snapshot: snapshot() }));
    act(() => button(container, "approval-1").click());
    await act(async () => button(container, "接受并执行一次").click());
    expect(container.textContent).toContain("已由其他通道处理");
    expect(client.refresh).toHaveBeenCalledTimes(1);
  });

  testWithIds(["LC-SC-034", "LC-SC-036", "LC-AC-006"],
    "操作取消立即显示已请求，重复点击禁用且最终服从权威快照", async () => {
    let dispatch!: React.Dispatch<ConsoleAction>;
    let resolveCancel!: (value: { status: "cancel_requested"; operation: ConsoleOperation }) => void;
    const cancelOperation = vi.fn(() => new Promise<{ status: "cancel_requested"; operation: ConsoleOperation }>(
      (resolve) => { resolveCancel = resolve; }
    ));
    const client = mockClient({ cancelOperation });
    ({ root, container } = render((next) => { dispatch = next; return client; }));
    await act(async () => dispatch({ type: "snapshot", snapshot: snapshot() }));
    act(() => button(container, "operation-1").click());
    const cancel = button(container, "请求取消操作");
    act(() => cancel.click());
    expect(container.textContent).toContain("已请求取消");
    expect(cancelOperation).toHaveBeenCalledTimes(1);
    expect(button(container, "已请求取消").disabled).toBe(true);
    await act(async () => resolveCancel({ status: "cancel_requested", operation: snapshot().operations[0]! }));

    await act(async () => dispatch({ type: "snapshot", snapshot: {
      ...snapshot(), revision: 2,
      operations: [{ ...snapshot().operations[0]!, state: "completed", cancelRequested: false }]
    } }));
    expect(container.textContent).toContain("真实状态：已完成");
    expect(Array.from(container.querySelectorAll("button")).some((item) => item.textContent?.includes("请求取消操作"))).toBe(false);
  });

  testWithIds(["LC-SC-042"], "断线时审批和操作取消入口全部禁用", async () => {
    let dispatch!: React.Dispatch<ConsoleAction>;
    const client = mockClient();
    ({ root, container } = render((next) => { dispatch = next; return client; }));
    await act(async () => dispatch({ type: "snapshot", snapshot: snapshot() }));
    act(() => button(container, "operation-1").click());
    await act(async () => dispatch({ type: "disconnected" }));
    expect(button(container, "请求取消操作").disabled).toBe(true);
    act(() => button(container, "approval-1").click());
    expect(button(container, "接受并执行一次").disabled).toBe(true);
    expect(button(container, "拒绝").disabled).toBe(true);
    expect(button(container, "取消").disabled).toBe(true);
  });
});

function mockClient(overrides: Partial<ConsoleClient> = {}): ConsoleClient {
  return {
    refresh: vi.fn(async () => undefined),
    loadOutput: vi.fn(async () => ({ frames: [], nextCursor: 0, minCursor: 0, truncated: false, droppedBytes: 0 })),
    previewCommand: vi.fn(async () => { throw new Error("未调用"); }),
    previewProfile: vi.fn(async () => { throw new Error("未调用"); }),
    decideApproval: vi.fn(async () => undefined),
    cancelOperation: vi.fn(async (): Promise<OperationCancelResponse> => ({
      status: "cancel_requested", operation: snapshot().operations[0]!
    })),
    close: vi.fn(),
    ...overrides
  };
}

function render(factory: (dispatch: React.Dispatch<ConsoleAction>) => ConsoleClient) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<App clientFactory={factory} />));
  return { root, container };
}

function snapshot(): RuntimeSnapshot {
  return {
    instanceId: "instance", revision: 1, serviceState: "active",
    hosts: [{ alias: "linux", environment: "test", platform: "linux", shell: "posix", connectionState: "connected" }],
    operations: [{
      operationId: "operation-1", source: "mcp", kind: "command", hosts: ["linux"], state: "running",
      cancelRequested: false, lastStateChangeAt: 0, outputTruncated: false, progress: {}
    }],
    sessions: [], profiles: [], approvals: [{
      approvalId: "approval-1", operationId: "operation-1", state: "pending", route: "dual",
      kind: "raw_command", hosts: ["linux"], createdAt: 0, expiresAt: Date.now() + 60_000,
      digest: "a".repeat(64),
      safeView: {
        operation: {
          kind: "raw_command", hosts: ["linux"], platformByHost: { linux: "linux" },
          payload: { command: "printf '<script>中文</script>'" }
        },
        impact: "批准后执行此精确操作一次"
      }
    }]
  };
}

function button(container: HTMLElement | undefined, text: string): HTMLButtonElement {
  const result = Array.from(container?.querySelectorAll("button") ?? [])
    .find((item) => item.textContent?.includes(text));
  if (result === undefined) throw new Error(`未找到按钮：${text}`);
  return result;
}
