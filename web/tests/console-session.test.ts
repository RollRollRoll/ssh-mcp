import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapConsoleSession } from "../src/console-session";

describe("控制台会话引导", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("从 fragment 交换 HttpOnly 会话，成功后立即清除 fragment", async () => {
    window.history.replaceState(null, "", `/#access_token=${"a".repeat(43)}`);
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);

    await bootstrapConsoleSession();

    expect(fetch).toHaveBeenCalledWith("/api/v1/session", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-ssh-mcp-request": "1" },
      body: JSON.stringify({ accessToken: "a".repeat(43) })
    });
    expect(window.location.hash).toBe("");
  });

  it("没有 fragment 时不发送请求，失败时不把 token 移入其他位置", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await bootstrapConsoleSession();
    expect(fetch).not.toHaveBeenCalled();

    window.history.replaceState(null, "", "/#access_token=failed-token");
    fetch.mockResolvedValue(new Response(null, { status: 401 }));
    await expect(bootstrapConsoleSession()).rejects.toThrow("控制台会话建立失败");
    expect(window.location.search).toBe("");
  });
});
