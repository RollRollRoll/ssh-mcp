import { useCallback, useRef } from "react";
import type { ConsoleApproval } from "../console-types";
import { useDialogFocus } from "./use-dialog-focus";

export function ApprovalDialog({ approval, busy, onDecision, onClose }: {
  readonly approval: ConsoleApproval;
  readonly busy: boolean;
  readonly onDecision: (action: "accept" | "decline" | "cancel") => void;
  readonly onClose: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const pending = approval.state === "pending";
  const escape = useCallback(() => {
    if (!busy && pending) onDecision("cancel");
    else if (!busy) onClose();
  }, [busy, onClose, onDecision, pending]);
  useDialogFocus(dialog, escape);
  const command = typeof approval.safeView.operation.payload.command === "string"
    ? approval.safeView.operation.payload.command : undefined;
  return (
    <div className="dialog-backdrop">
      <section ref={dialog} tabIndex={-1} className="preview-dialog" role="dialog" aria-modal="true"
        aria-labelledby="approval-title">
        <header><p className="eyebrow">COORDINATED APPROVAL</p><h2 id="approval-title">处理待审批操作</h2></header>
        <dl>
          <div><dt>审批状态</dt><dd>{stateLabel(approval.state)}</dd></div>
          <div><dt>来源通道</dt><dd>{approval.route === "dual" ? "MCP 与网页双通道" : "仅网页"}</dd></div>
          <div><dt>操作类型</dt><dd>{approval.safeView.operation.kind}</dd></div>
          <div><dt>目标主机</dt><dd>{approval.safeView.operation.hosts.join(", ")}</dd></div>
          <div><dt>平台</dt><dd>{Object.values(approval.safeView.operation.platformByHost).join(", ")}</dd></div>
          <div><dt>影响</dt><dd>{approval.safeView.impact}</dd></div>
          <div><dt>SHA-256 摘要</dt><dd className="digest">{approval.digest}</dd></div>
          <div><dt>到期时间</dt><dd>{new Date(approval.expiresAt).toLocaleString()}</dd></div>
          {approval.resolvedBy !== undefined && <div><dt>决定来源</dt><dd>{approval.resolvedBy}</dd></div>}
        </dl>
        <h3>完整安全内容</h3>
        <pre className="preview-command">{command ?? JSON.stringify(approval.safeView.operation.payload, null, 2)}</pre>
        <div className="dialog-actions">
          {pending ? <>
            <button type="button" disabled={busy} onClick={() => onDecision("cancel")}>取消</button>
            <button type="button" disabled={busy} onClick={() => onDecision("decline")}>拒绝</button>
            <button type="button" className="primary-action" disabled={busy}
              onClick={() => onDecision("accept")}>接受并执行一次</button>
          </> : <button type="button" disabled={busy} onClick={onClose}>关闭（已处理）</button>}
        </div>
      </section>
    </div>
  );
}

function stateLabel(state: string): string {
  return ({
    pending: "等待审批", accepted: "已接受", declined: "已拒绝", cancelled: "已取消",
    timed_out: "已超时", failed: "失败"
  } as Record<string, string>)[state] ?? state;
}
