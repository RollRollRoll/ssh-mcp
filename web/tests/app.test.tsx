import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import App from "../src/App";

describe("控制台原型", () => {
  let root: Root | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
  });

  it("在提交操作前展示一次性审批确认", () => {
    const container = document.createElement("div");
    document.body.append(container);

    act(() => {
      root = createRoot(container);
      root.render(<App />);
    });

    const openApproval = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("检查并运行"));
    expect(openApproval).toBeDefined();

    act(() => openApproval?.click());
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("确认远程操作");

    const approve = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("批准并执行"));
    act(() => approve?.click());

    expect(container.querySelector('[role="status"]')?.textContent).toContain("操作已提交");
  });
});
