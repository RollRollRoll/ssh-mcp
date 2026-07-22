const WRITE_HEADER = "x-ssh-mcp-request";

/** URL fragment 只在内存中用于一次同源交换，绝不进入 query 或 Web Storage。 */
export async function bootstrapConsoleSession(): Promise<void> {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const accessToken = fragment.get("access_token");
  if (accessToken === null) return;
  const response = await fetch("/api/v1/session", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      [WRITE_HEADER]: "1"
    },
    body: JSON.stringify({ accessToken })
  });
  if (!response.ok) throw new Error("控制台会话建立失败");
  window.history.replaceState(null, "", window.location.pathname);
}
