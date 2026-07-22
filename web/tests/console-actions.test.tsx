import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { createConsoleClient, type ConsoleClient } from "../src/console-client";
import type { ConsoleAction } from "../src/console-state";
import type { ConsolePreview, OperationCancelResponse, RuntimeSnapshot } from "../src/console-types";
import { testWithIds } from "../../tests/test-with-ids.js";

describe("控制台操作表单", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    vi.unstubAllGlobals();
  });

  testWithIds(["LC-SC-019", "LC-AC-004"], "命令先展示冻结原文与摘要，明确接受后才发送决定", async () => {
    let dispatch!: React.Dispatch<ConsoleAction>;
    const client = mockClient({
      previewCommand: vi.fn(async () => preview("raw_command", "printf '中文'\n$HOME;"))
    });
    ({ root, container } = render((next) => { dispatch = next; return client; }));
    await act(async () => dispatch({ type: "snapshot", snapshot: snapshot() }));

    const textarea = container.querySelector("textarea")!;
    act(() => change(textarea, "printf '中文'\n$HOME;"));
    await act(async () => button(container!, "生成确认预览", 0).click());
    expect(client.previewCommand).toHaveBeenCalledWith({ host: "linux", command: "printf '中文'\n$HOME;" });
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("printf '中文'\n$HOME;");
    expect(dialog.textContent).toContain("a".repeat(64));

    await act(async () => button(container!, "接受并执行一次").click());
    expect(client.decideApproval).toHaveBeenCalledWith("approval-1", "accept", "a".repeat(64));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain("操作已接受");
    await vi.waitFor(() => expect(document.activeElement?.textContent).toContain("生成确认预览"));
  });

  testWithIds(["LC-SC-021"], "影响字段变化取消旧预览，迟到响应也不会重新打开", async () => {
    let dispatch!: React.Dispatch<ConsoleAction>;
    let resolvePreview!: (value: ConsolePreview) => void;
    const previewCommand = vi.fn(() => new Promise<ConsolePreview>((resolve) => { resolvePreview = resolve; }));
    const client = mockClient({ previewCommand });
    ({ root, container } = render((next) => { dispatch = next; return client; }));
    await act(async () => dispatch({ type: "snapshot", snapshot: snapshot() }));
    const textarea = container.querySelector("textarea")!;
    act(() => change(textarea, "echo first"));
    act(() => button(container!, "生成确认预览", 0).click());
    act(() => change(textarea, "echo second"));
    await act(async () => resolvePreview(preview("raw_command", "echo first")));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(client.decideApproval).toHaveBeenCalledWith("approval-1", "cancel", "a".repeat(64));

    previewCommand.mockImplementation(async () => preview("raw_command", "echo second"));
    await act(async () => button(container!, "生成确认预览", 0).click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    act(() => change(textarea, "echo third"));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(client.decideApproval).toHaveBeenLastCalledWith("approval-1", "cancel", "a".repeat(64));
  });

  testWithIds(["LC-SC-020"], "Profile 依据安全投影生成参数并预览服务端实际命令", async () => {
    let dispatch!: React.Dispatch<ConsoleAction>;
    const client = mockClient({
      previewProfile: vi.fn(async () => preview("profile", "'/usr/bin/printf' '中文'"))
    });
    ({ root, container } = render((next) => { dispatch = next; return client; }));
    await act(async () => dispatch({ type: "snapshot", snapshot: snapshot() }));
    const enumSelect = Array.from(container.querySelectorAll("select"))
      .find((select) => Array.from(select.options).some((option) => option.value === "中文"))!;
    act(() => change(enumSelect, "中文"));
    await act(async () => button(container!, "生成确认预览", 1).click());
    expect(client.previewProfile).toHaveBeenCalledWith({
      host: "linux", profileId: "echo", parameters: { value: "中文" }
    });
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("'/usr/bin/printf' '中文'");
  });

  it("浏览器写请求固定携带同源 Cookie、JSON 与 CSRF 自定义头", async () => {
    vi.stubGlobal("EventSource", class {
      public onerror: (() => void) | null = null;
      public addEventListener(): void {}
      public close(): void {}
    });
    const expected = preview("raw_command", "echo 中文");
    const fetchMock = vi.fn(async () => ({ ok: true, status: 201, json: async () => expected } as Response));
    vi.stubGlobal("fetch", fetchMock);
    const client = createConsoleClient(() => undefined);
    await expect(client.previewCommand({ host: "linux", command: "echo 中文" })).resolves.toEqual(expected);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/previews/command", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        accept: "application/json", "content-type": "application/json", "x-ssh-mcp-request": "1"
      },
      body: JSON.stringify({ host: "linux", command: "echo 中文" })
    });
    client.close();
  });
});

function mockClient(overrides: Partial<ConsoleClient> = {}): ConsoleClient {
  return {
    refresh: vi.fn(async () => undefined),
    loadOutput: vi.fn(async () => ({ frames: [], nextCursor: 0, minCursor: 0, truncated: false, droppedBytes: 0 })),
    previewCommand: vi.fn(async () => preview("raw_command", "true")),
    previewProfile: vi.fn(async () => preview("profile", "true")),
    decideApproval: vi.fn(async () => undefined),
    cancelOperation: vi.fn(async (): Promise<OperationCancelResponse> => ({
      status: "terminal", operation: snapshot().operations[0]!
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
    hosts: [{
      alias: "linux", environment: "test", platform: "linux", shell: "posix", connectionState: "connected"
    }],
    operations: [], sessions: [], approvals: [],
    profiles: [{
      id: "echo", platform: "linux", hostAliases: ["linux"],
      parameters: [{ type: "enum", name: "value", required: true, values: ["中文"] }]
    }]
  };
}

function preview(kind: "raw_command" | "profile", command: string): ConsolePreview {
  return {
    approvalId: "approval-1", operationId: "operation-1", digest: "a".repeat(64), expiresAt: Date.now() + 60_000,
    impact: "只执行此精确操作一次", intent: {
      kind, hosts: ["linux"], platformByHost: { linux: "linux" },
      payload: kind === "profile" ? { profileId: "echo", parameters: { value: "中文" }, command } : { command },
      canonicalJson: "{}"
    }
  };
}

function button(container: HTMLElement, text: string, index = 0): HTMLButtonElement {
  const matches = Array.from(container.querySelectorAll("button")).filter((item) => item.textContent?.includes(text));
  const result = matches[index];
  if (result === undefined) throw new Error(`未找到按钮：${text}`);
  return result;
}

function change(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}
