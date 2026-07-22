import type { Dispatch } from "react";
import type { ConsoleAction } from "./console-state";
import type { ConsolePreview, OperationOutput, RuntimeSnapshot } from "./console-types";

export interface ConsoleClient {
  readonly refresh: () => Promise<void>;
  readonly loadOutput: (operationId: string, cursor?: number) => Promise<OperationOutput>;
  readonly previewCommand: (input: { readonly host: string; readonly command: string }) => Promise<ConsolePreview>;
  readonly previewProfile: (input: {
    readonly host: string;
    readonly profileId: string;
    readonly parameters: Readonly<Record<string, string | number | boolean>>;
  }) => Promise<ConsolePreview>;
  readonly decideApproval: (
    approvalId: string,
    action: "accept" | "decline" | "cancel",
    expectedDigest: string
  ) => Promise<void>;
  readonly close: () => void;
}

export function createConsoleClient(dispatch: Dispatch<ConsoleAction>): ConsoleClient {
  let closed = false;
  let refreshPromise: Promise<void> | undefined;
  const events = new EventSource("/api/v1/events", { withCredentials: true });

  const refresh = (): Promise<void> => {
    if (closed) return Promise.resolve();
    dispatch({ type: "syncing" });
    refreshPromise ??= fetchJson<RuntimeSnapshot>("/api/v1/snapshot")
      .then((snapshot) => { if (!closed) dispatch({ type: "snapshot", snapshot }); })
      .catch(() => { if (!closed) dispatch({ type: "disconnected" }); })
      .finally(() => { refreshPromise = undefined; });
    return refreshPromise;
  };

  events.addEventListener("ready", () => {
    if (closed) return;
    dispatch({ type: "ready" });
    void refresh();
  });
  events.addEventListener("invalidated", () => { void refresh(); });
  events.addEventListener("offline", () => {
    if (closed) return;
    dispatch({ type: "disconnected" });
    events.close();
  });
  events.onerror = () => { if (!closed) dispatch({ type: "disconnected" }); };

  return {
    refresh,
    loadOutput: (operationId, cursor = 0) => fetchJson<OperationOutput>(
      `/api/v1/operations/${encodeURIComponent(operationId)}/output?cursor=${cursor}&maxBytes=262144`
    ),
    previewCommand: (input) => postJson<ConsolePreview>("/api/v1/previews/command", input),
    previewProfile: (input) => postJson<ConsolePreview>("/api/v1/previews/profile", input),
    decideApproval: async (approvalId, action, expectedDigest) => {
      await postJson(`/api/v1/approvals/${encodeURIComponent(approvalId)}/decision`, { action, expectedDigest });
    },
    close: () => {
      if (closed) return;
      closed = true;
      events.close();
    }
  };
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-ssh-mcp-request": "1"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(await safeErrorCode(response));
  return await response.json() as T;
}

async function safeErrorCode(response: Response): Promise<string> {
  try {
    const body = await response.json() as { readonly error?: { readonly code?: unknown } };
    return typeof body.error?.code === "string" ? body.error.code : `HTTP_${response.status}`;
  } catch {
    return `HTTP_${response.status}`;
  }
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`控制台请求失败：${response.status}`);
  return await response.json() as T;
}
