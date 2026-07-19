import type { HostConfig } from "../config/schema.js";
import { ErrorCodes } from "../errors/error-codes.js";

const MAX_PROBE_OUTPUT_BYTES = 4 * 1024;
const LINUX_SCRIPT = "if [ \"$(uname -s)\" = \"Linux\" ]; then printf 'SSH_MCP_PLATFORM=linux\\nSSH_MCP_SHELL=posix\\n'; else exit 1; fi";
const WINDOWS_SCRIPT = [
  "if ($env:OS -ne 'Windows_NT') { exit 1 }",
  "$major = $PSVersionTable.PSVersion.Major",
  "if ($major -lt 5) { exit 1 }",
  "[Console]::Out.WriteLine('SSH_MCP_PLATFORM=windows')",
  "[Console]::Out.WriteLine('SSH_MCP_SHELL=powershell')",
  "[Console]::Out.WriteLine(('SSH_MCP_PS_MAJOR={0}' -f $major))"
].join("\n");

export interface ProbeChannel {
  readonly stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  destroy?(): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: (code: number | undefined, signal: string | undefined) => void): this;
}

export interface ProbeClient {
  exec(command: string, callback: (error: Error | undefined, channel: ProbeChannel) => void): unknown;
}

export class PlatformProbeError extends Error {
  public readonly code = ErrorCodes.PLATFORM_MISMATCH;

  public constructor() {
    super("目标平台或 Shell 与登记配置不匹配");
    this.name = "PlatformProbeError";
  }
}

export async function runPlatformProbe(client: ProbeClient, host: HostConfig): Promise<void> {
  const command = host.platform === "linux"
    ? `${quotePosix(host.shell.command)} -c ${quotePosix(LINUX_SCRIPT)}`
    : `${quoteWindowsExecutable(host.shell.command)} -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(WINDOWS_SCRIPT, "utf16le").toString("base64")}`;
  const output = await executeProbe(client, command);
  validateOutput(host.platform, output);
}

function executeProbe(client: ProbeClient, command: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let channel: ProbeChannel | undefined;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const fail = (): void => {
      if (!settled) {
        settled = true;
        try { channel?.destroy?.(); } catch { /* 探针已失败，销毁异常不得二次结算。 */ }
        reject(new PlatformProbeError());
      }
    };
    const append = (target: "stdout" | "stderr", chunk: Buffer | string): void => {
      if (settled) return;
      const current = target === "stdout" ? stdout : stderr;
      const other = target === "stdout" ? stderr : stdout;
      const chunkBytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, "utf8");
      if (chunkBytes > MAX_PROBE_OUTPUT_BYTES - current.length - other.length) {
        fail();
        return;
      }
      const next = Buffer.concat([current, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)], current.length + chunkBytes);
      if (target === "stdout") stdout = next;
      else stderr = next;
    };
    try {
      client.exec(command, (error, rawChannel) => {
        if (error !== undefined) {
          fail();
          return;
        }
        channel = rawChannel;
        channel.on("data", (chunk) => append("stdout", chunk));
        channel.stderr.on("data", (chunk) => append("stderr", chunk));
        channel.on("error", fail);
        channel.on("close", (code) => {
          if (settled) return;
          settled = true;
          resolve({ stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), code: code ?? -1 });
        });
      });
    } catch {
      fail();
    }
  });
}

function validateOutput(platform: HostConfig["platform"], output: { stdout: string; stderr: string; code: number }): void {
  if (output.code !== 0 || output.stderr !== "") {
    throw new PlatformProbeError();
  }
  const lines = output.stdout.replace(/\r\n/g, "\n").split("\n").filter((line) => line.length > 0);
  if (platform === "linux") {
    if (lines.length !== 2 || lines[0] !== "SSH_MCP_PLATFORM=linux" || lines[1] !== "SSH_MCP_SHELL=posix") {
      throw new PlatformProbeError();
    }
    return;
  }
  const match = /^SSH_MCP_PS_MAJOR=(\d+)$/.exec(lines[2] ?? "");
  if (lines.length !== 3
    || lines[0] !== "SSH_MCP_PLATFORM=windows"
    || lines[1] !== "SSH_MCP_SHELL=powershell"
    || match === null
    || Number(match[1]) < 5) {
    throw new PlatformProbeError();
  }
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function quoteWindowsExecutable(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
