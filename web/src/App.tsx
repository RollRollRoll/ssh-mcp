import { useCallback, useEffect, useReducer, useRef, useState, type Dispatch } from "react";
import { createConsoleClient, type ConsoleClient } from "./console-client";
import { consoleReducer, initialConsoleState, writesEnabled, type ConsoleAction } from "./console-state";
import type { ConsolePreview } from "./console-types";
import { CommandForm } from "./components/command-form";
import { ProfileForm } from "./components/profile-form";
import { OperationPreviewDialog } from "./components/operation-preview-dialog";

export interface AppProps {
  readonly clientFactory?: (dispatch: Dispatch<ConsoleAction>) => ConsoleClient;
}

const terminalStates = new Set(["completed", "failed", "timed_out", "cancelled", "partial_failure", "unknown"]);

export default function App({ clientFactory = createConsoleClient }: AppProps) {
  const [state, dispatch] = useReducer(consoleReducer, initialConsoleState);
  const [client, setClient] = useState<ConsoleClient>();
  const [preview, setPreview] = useState<ConsolePreview>();
  const [actionBusy, setActionBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<string>();
  const actionVersion = useRef(0);
  const snapshot = state.snapshot;
  const selected = snapshot?.operations.find((item) => item.operationId === state.selectedOperationId);

  useEffect(() => {
    const current = clientFactory(dispatch);
    setClient(current);
    return () => current.close();
  }, [clientFactory]);
  useEffect(() => {
    if (client === undefined || selected === undefined || state.connection !== "online") return;
    let current = true;
    const requestedCursor = state.output?.nextCursor ?? 0;
    void client.loadOutput(selected.operationId, requestedCursor)
      .then((output) => {
        if (current) dispatch({ type: "output", operationId: selected.operationId, requestedCursor, output });
      })
      .catch(() => undefined);
    return () => { current = false; };
  }, [client, selected?.operationId, snapshot?.revision, state.connection, state.output?.nextCursor]);

  const activeOperations = snapshot?.operations.filter((item) => !terminalStates.has(item.state)).length ?? 0;
  const pendingApprovals = snapshot?.approvals.filter((item) => item.state === "pending").length ?? 0;
  const canWrite = writesEnabled(state) && client !== undefined;

  const invalidatePreview = useCallback((): void => {
    actionVersion.current += 1;
    setPreview((current) => {
      if (current !== undefined && client !== undefined) {
        void client.decideApproval(current.approvalId, "cancel", current.digest).catch(() => undefined);
      }
      return undefined;
    });
    setActionBusy(false);
    setActionMessage(undefined);
  }, [client]);

  const requestPreview = async (request: () => Promise<ConsolePreview>): Promise<void> => {
    const version = ++actionVersion.current;
    const previous = preview;
    setPreview(undefined);
    setActionMessage(undefined);
    setActionBusy(true);
    if (previous !== undefined && client !== undefined) {
      void client.decideApproval(previous.approvalId, "cancel", previous.digest).catch(() => undefined);
    }
    try {
      const next = await request();
      if (version === actionVersion.current) setPreview(next);
      else if (client !== undefined) {
        void client.decideApproval(next.approvalId, "cancel", next.digest).catch(() => undefined);
      }
    } catch (error: unknown) {
      if (version === actionVersion.current) {
        setActionMessage(`预览失败：${error instanceof Error ? error.message : "INVALID_REQUEST"}`);
      }
    } finally {
      if (version === actionVersion.current) setActionBusy(false);
    }
  };

  const decidePreview = async (action: "accept" | "cancel"): Promise<void> => {
    if (client === undefined || preview === undefined) return;
    const current = preview;
    actionVersion.current += 1;
    setActionBusy(true);
    try {
      await client.decideApproval(current.approvalId, action, current.digest);
      setPreview(undefined);
      setActionMessage(action === "accept" ? "操作已接受，正在等待实时状态。" : "预览已取消，未执行操作。");
    } catch (error: unknown) {
      setPreview(undefined);
      setActionMessage(`决定失败：${error instanceof Error ? error.message : "INVALID_REQUEST"}`);
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <main className="console-page" data-write-enabled={writesEnabled(state) ? "true" : "false"}>
      <header className="console-header">
        <div>
          <p className="eyebrow">SSH MCP · LOCAL CONSOLE</p>
          <h1>当前进程工作台</h1>
          <p className="instance-id">实例 {snapshot?.instanceId ?? "等待同步"}</p>
        </div>
        <div className={`connection-state ${state.connection}`} role="status">
          <span aria-hidden="true" />{connectionLabel(state.connection)}
          <button type="button" disabled={client === undefined} onClick={() => void client?.refresh()}>刷新快照</button>
        </div>
      </header>

      {snapshot === undefined ? (
        <section className="loading-panel"><h2>正在连接本机控制台</h2><p>等待服务端发送当前实例的权威快照。</p></section>
      ) : (
        <>
          <section className="summary-cards" aria-label="运行摘要">
            <article><span>服务状态</span><strong>{snapshot.serviceState === "active" ? "运行中" : "正在退出"}</strong></article>
            <article><span>登记主机</span><strong>{snapshot.hosts.length}</strong></article>
            <article><span>活动操作</span><strong>{activeOperations}</strong></article>
            <article><span>待审批</span><strong>{pendingApprovals}</strong></article>
            <article><span>修订号</span><strong>{snapshot.revision}</strong></article>
          </section>

          <section className="action-grid" aria-label="发起远程操作">
            <article className="console-panel">
              <header><h2>单主机命令</h2><small>提交前必须核对冻结预览</small></header>
              <CommandForm hosts={snapshot.hosts} disabled={!canWrite} busy={actionBusy} onChange={invalidatePreview}
                onPreview={(input) => {
                  if (client !== undefined) void requestPreview(() => client.previewCommand(input));
                }} />
            </article>
            <article className="console-panel">
              <header><h2>低风险 Profile</h2><small>网页执行仍需明确确认</small></header>
              <ProfileForm hosts={snapshot.hosts} profiles={snapshot.profiles} disabled={!canWrite} busy={actionBusy}
                onChange={invalidatePreview}
                onPreview={(input) => {
                  if (client !== undefined) void requestPreview(() => client.previewProfile(input));
                }} />
            </article>
          </section>
          {actionMessage !== undefined && <p className="action-message" role="status">{actionMessage}</p>}

          <section className="console-grid">
            <article className="console-panel">
              <header><h2>主机状态</h2><small>仅显示安全别名和运行状态</small></header>
              {snapshot.hosts.length === 0 ? <Empty text="当前实例没有登记主机。" /> : (
                <ul className="record-list">{snapshot.hosts.map((host) => (
                  <li key={host.alias}>
                    <strong>{host.alias}</strong>
                    <span>{host.environment} · {host.platform} · {host.shell}</span>
                    <StateBadge value={host.connectionState} />
                  </li>
                ))}</ul>
              )}
            </article>

            <article className="console-panel operations-panel">
              <header><h2>操作</h2><small>选择一项查看 stdout / stderr</small></header>
              {snapshot.operations.length === 0 ? <Empty text="当前没有操作记录。" /> : (
                <ul className="record-list">{snapshot.operations.map((operation) => (
                  <li key={operation.operationId}>
                    <button type="button" className="record-button"
                      aria-pressed={selected?.operationId === operation.operationId}
                      onClick={() => dispatch({ type: "select-operation", operationId: operation.operationId })}>
                      <strong>{operation.operationId}</strong>
                      <span>{operation.kind} · {operation.source} · {operation.hosts.join(", ") || "无目标"}</span>
                      <StateBadge value={operation.cancelRequested ? "cancel_requested" : operation.state} />
                    </button>
                  </li>
                ))}</ul>
              )}
            </article>

            <article className="console-panel output-panel">
              <header><h2>操作输出</h2><small>{selected?.operationId ?? "尚未选择操作"}</small></header>
              {selected === undefined ? <Empty text="选择一个操作后显示缓冲输出。" />
                : state.output === undefined ? <Empty text="正在读取输出。" />
                  : state.output.frames.length === 0 ? <Empty text="该操作尚无输出。" /> : (
                    <div className="output-stream" aria-label="操作输出">
                      {state.output.truncated && <p className="warning">较早输出已丢弃 {state.output.droppedBytes} 字节。</p>}
                      {state.output.frames.map((frame, index) => (
                        <section key={`${frame.cursor}-${index}`} className={`output-frame ${frame.stream}`}>
                          <small>{frame.host === undefined ? frame.stream : `${frame.host} · ${frame.stream}`}</small>
                          <pre>{frame.encoding === "utf8" ? frame.data : `[base64] ${frame.data}`}</pre>
                        </section>
                      ))}
                    </div>
                  )}
            </article>

            <article className="console-panel">
              <header><h2>会话</h2><small>只读状态</small></header>
              {snapshot.sessions.length === 0 ? <Empty text="当前没有终端会话。" /> : (
                <ul className="record-list">{snapshot.sessions.map((session) => (
                  <li key={session.sessionId}><strong>{session.sessionId}</strong>
                    <span>{session.host} · {session.columns}×{session.rows}</span><StateBadge value={session.state} /></li>
                ))}</ul>
              )}
            </article>

            <article className="console-panel">
              <header><h2>审批</h2><small>当前进程的协调状态</small></header>
              {snapshot.approvals.length === 0 ? <Empty text="当前没有审批记录。" /> : (
                <ul className="record-list">{snapshot.approvals.map((approval) => (
                  <li key={approval.approvalId}><strong>{approval.approvalId}</strong>
                    <span>{approval.kind} · {approval.hosts.join(", ")}</span><StateBadge value={approval.state} /></li>
                ))}</ul>
              )}
            </article>
          </section>
        </>
      )}
      {preview !== undefined && <OperationPreviewDialog preview={preview} busy={actionBusy || !canWrite}
        onAccept={() => void decidePreview("accept")} onCancel={() => void decidePreview("cancel")} />}
    </main>
  );
}

function Empty({ text }: { readonly text: string }) {
  return <p className="empty-state">{text}</p>;
}

function StateBadge({ value }: { readonly value: string }) {
  return <span className={`state-badge state-${value}`}>{value}</span>;
}

function connectionLabel(state: "connecting" | "syncing" | "online" | "disconnected"): string {
  if (state === "connecting") return "正在连接";
  if (state === "syncing") return "正在同步";
  if (state === "online") return "实时在线";
  return "连接已断开（写操作已禁用）";
}
