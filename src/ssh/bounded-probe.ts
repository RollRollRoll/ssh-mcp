import { ErrorCodes } from "../errors/error-codes.js";
import { PathGuardError } from "../paths/path-guard.js";
import type { ProbeChannel, ProbeClient } from "./platform-probe.js";

interface DestroyableProbeChannel extends ProbeChannel {
  destroy?(): unknown;
}

/** 对路径安全探针执行硬字节限制；超限时立即销毁 channel 并关闭失败。 */
export async function executeBoundedProbe(
  client: ProbeClient,
  command: string,
  maxOutputBytes: number
): Promise<{ readonly stdout: string; readonly stderr: string; readonly code: number }> {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new PathGuardError(ErrorCodes.PATH_DENIED);
  return await new Promise((resolve, reject) => {
    let settled = false;
    let channel: DestroyableProbeChannel | undefined;
    let acceptedBytes = 0;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const fail = (): void => {
      if (settled) return;
      settled = true;
      try { channel?.destroy?.(); } catch { /* 已保守拒绝，销毁失败不得二次结算。 */ }
      reject(new PathGuardError(ErrorCodes.PATH_DENIED));
    };
    const append = (target: Buffer[], chunk: Buffer | string): void => {
      if (settled) return;
      const remaining = maxOutputBytes - acceptedBytes;
      const chunkBytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, "utf8");
      if (chunkBytes > remaining) {
        fail();
        return;
      }
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      acceptedBytes += data.length;
      target.push(data);
      if (target === stdout) stdoutBytes += data.length;
      else stderrBytes += data.length;
    };
    try {
      client.exec(command, (error, rawChannel) => {
        if (settled) return;
        if (error !== undefined) { fail(); return; }
        channel = rawChannel as DestroyableProbeChannel;
        channel.on("data", (chunk) => append(stdout, chunk));
        channel.stderr.on("data", (chunk) => append(stderr, chunk));
        channel.on("error", fail);
        channel.on("close", (code) => {
          if (settled) return;
          settled = true;
          resolve({
            stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8"),
            stderr: Buffer.concat(stderr, stderrBytes).toString("utf8"),
            code: code ?? -1
          });
        });
      });
    } catch { fail(); }
  });
}
