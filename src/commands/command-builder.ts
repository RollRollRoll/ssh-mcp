import type { HostConfig } from "../config/schema.js";

/** 将原始命令作为登记 Shell 的一个参数传递，绝不翻译或改写其语义。 */
export function buildCommand(host: HostConfig, command: string): string {
  if (host.platform === "linux") {
    return `${quotePosix(host.shell.command)} -lc ${quotePosix(command)}`;
  }
  return `${quoteWindowsExecutable(host.shell.command)} -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(command, "utf16le").toString("base64")}`;
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function quoteWindowsExecutable(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
