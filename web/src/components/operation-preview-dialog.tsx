import { useCallback, useRef } from "react";
import type { ConsolePreview } from "../console-types";
import { useDialogFocus } from "./use-dialog-focus";

export function OperationPreviewDialog({ preview, busy, onAccept, onCancel }: {
  readonly preview: ConsolePreview;
  readonly busy: boolean;
  readonly onAccept: () => void;
  readonly onCancel: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const escape = useCallback(() => { if (!busy) onCancel(); }, [busy, onCancel]);
  useDialogFocus(dialog, escape, !busy);
  const command = typeof preview.intent.payload.command === "string" ? preview.intent.payload.command : "";
  return (
    <div className="dialog-backdrop">
      <section ref={dialog} tabIndex={-1} className="preview-dialog" role="dialog" aria-modal="true" aria-labelledby="preview-title">
        <header><p className="eyebrow">FROZEN OPERATION INTENT</p><h2 id="preview-title">确认精确远程操作</h2></header>
        <dl>
          <div><dt>目标主机</dt><dd>{preview.intent.hosts.join(", ")}</dd></div>
          <div><dt>平台</dt><dd>{Object.values(preview.intent.platformByHost).join(", ")}</dd></div>
          {preview.intent.kind === "profile" && <div><dt>Profile</dt><dd>{String(preview.intent.payload.profileId)}</dd></div>}
          <div><dt>影响</dt><dd>{preview.impact}</dd></div>
          <div><dt>SHA-256 摘要</dt><dd className="digest">{preview.digest}</dd></div>
          <div><dt>到期时间</dt><dd>{new Date(preview.expiresAt).toLocaleString()}</dd></div>
        </dl>
        <h3>实际命令</h3>
        <pre className="preview-command">{command}</pre>
        {preview.intent.kind === "profile" && <><h3>Profile 参数</h3>
          <pre className="preview-command">{JSON.stringify(preview.intent.payload.parameters, null, 2)}</pre></>}
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={onCancel}>取消，不执行</button>
          <button type="button" className="primary-action" disabled={busy} onClick={onAccept}>接受并执行一次</button>
        </div>
      </section>
    </div>
  );
}
