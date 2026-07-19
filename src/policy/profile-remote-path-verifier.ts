import { ErrorCodes } from "../errors/error-codes.js";
import { LinuxPathGuard } from "../paths/linux-path-guard.js";
import { WindowsPathGuard } from "../paths/windows-path-guard.js";
import { MAX_WINDOWS_REPARSE_PROBE_STDOUT_BYTES, WindowsReparseProbe } from "../paths/windows-reparse-probe.js";
import { executeBoundedProbe } from "../ssh/bounded-probe.js";
import type { SftpTransferSession, SshConnection } from "../ssh/ssh-adapter.js";
import type { CommandConnectionPreflight } from "../commands/command-runner.js";
import type { VerifiedProfileMatch } from "./policy-engine.js";

/** 在 CommandRunner 已取得、但尚未提交 exec 的同一连接上验证 Profile 远端路径。 */
export class ProfileRemotePathVerifier {
  public create(match: VerifiedProfileMatch): CommandConnectionPreflight | undefined {
    const paths = match.values
      .filter((value) => value.parameter.type === "remotePath")
      .map((value) => value.value)
      .filter((value): value is string => typeof value === "string");
    if (paths.length === 0) return undefined;
    return async (connection) => {
      let sftp: SftpTransferSession | undefined;
      try {
        sftp = await openSftp(connection);
        for (const path of paths) {
          const safe = match.host.platform === "linux"
            ? await new LinuxPathGuard(match.host.remoteRoots, sftp).verify(path)
            : await new WindowsPathGuard(match.host.remoteRoots, sftp, new WindowsReparseProbe({
              execute: async (command) => await executeBoundedProbe(connection, command, MAX_WINDOWS_REPARSE_PROBE_STDOUT_BYTES)
            }, match.host.shell.command)).verify(path);
          await safe.revalidateBeforeOpen();
        }
      } catch {
        throw Object.assign(new Error("低风险 Profile 的远端路径无法安全证明"), {
          code: ErrorCodes.POLICY_REQUIRES_APPROVAL
        });
      } finally {
        try { sftp?.close(); } catch { /* 路径验证失败已关闭执行，SFTP 关闭只做尽力清理。 */ }
      }
    };
  }
}

async function openSftp(connection: SshConnection): Promise<SftpTransferSession> {
  if (connection.openSftp === undefined) throw new Error("SFTP 不可用");
  return await new Promise((resolve, reject) => {
    connection.openSftp!((error, sftp) => error === undefined ? resolve(sftp) : reject(error));
  });
}
