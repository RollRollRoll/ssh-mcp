import { useRef, useState } from "react";
import type { ConsoleHost } from "../console-types";

export function CommandForm({
  hosts, disabled, busy, onChange, onPreview
}: {
  readonly hosts: readonly ConsoleHost[];
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly onChange: () => void;
  readonly onPreview: (
    input: { readonly host: string; readonly command: string },
    trigger: HTMLButtonElement | undefined
  ) => void;
}) {
  const [host, setHost] = useState(hosts[0]?.alias ?? "");
  const [command, setCommand] = useState("");
  const submit = useRef<HTMLButtonElement>(null);
  return (
    <form className="action-form" onSubmit={(event) => {
      event.preventDefault();
      onPreview({ host, command }, submit.current ?? undefined);
    }}>
      <label>目标主机
        <select value={host} disabled={disabled || hosts.length === 0} onChange={(event) => {
          setHost(event.target.value); onChange();
        }}>
          {hosts.map((item) => <option key={item.alias} value={item.alias}>{item.alias} · {item.platform}</option>)}
        </select>
      </label>
      <label>命令原文
        <textarea value={command} disabled={disabled} rows={5} placeholder="输入要在单台主机执行的命令"
          onChange={(event) => { setCommand(event.target.value); onChange(); }} />
      </label>
      <button ref={submit} type="submit" disabled={disabled || busy || host.length === 0 || command.trim().length === 0}>
        生成确认预览
      </button>
    </form>
  );
}
