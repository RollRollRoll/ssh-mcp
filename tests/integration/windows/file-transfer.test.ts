import path from "node:path";
import { lstat, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { HostConfig } from "../../../src/config/schema.js";
import { OperationManager } from "../../../src/operations/operation-manager.js";
import { StrictHostKeyVerifier, type TrustConfirmation } from "../../../src/ssh/host-key.js";
import { SshAdapter } from "../../../src/ssh/ssh-adapter.js";
import { TrustStore } from "../../../src/ssh/trust-store.js";
import { TransferService } from "../../../src/transfers/file-transfer.js";
import { SftpTransferBackend } from "../../../src/transfers/sftp-transfer-backend.js";

const enabled = process.platform === "win32" && process.env.SSH_MCP_WINDOWS_INTEGRATION === "1";

describe.skipIf(!enabled)("Windows OpenSSH SFTP 单文件传输", () => {
  it("真实覆盖盘符/大小写路径、二进制一致和原子替换能力判定", async () => {
    const localRoot = process.env.SSH_MCP_WINDOWS_LOCAL_ROOT ?? await mkdtemp(path.join(tmpdir(), "ssh-mcp-transfer-"));
    const remoteRoot = required("SSH_MCP_WINDOWS_REMOTE_ROOT");
    const source = path.win32.join(localRoot, "Source.bin");
    const download = path.win32.join(localRoot, "download.bin");
    const remote = path.win32.join(remoteRoot.toLocaleLowerCase("en-US"), `Transfer-${process.pid}-${Date.now()}.bin`);
    const content = Buffer.concat([Buffer.from([0, 255, 13, 10]), Buffer.from("中文")]);
    await writeFile(source, content);

    const manager = new OperationManager({ idFactory: sequence("windows-upload", "windows-replace", "windows-download") });
    const confirmation: TrustConfirmation = { supportsForm: () => true, confirm: async () => "accept" };
    const adapter = new SshAdapter(new StrictHostKeyVerifier(new TrustStore(path.win32.join(localRoot, "trust.json")), confirmation));
    const service = new TransferService(manager, new SftpTransferBackend(adapter, [localRoot], { localPlatform: "win32" }));

    const upload = service.start({ direction: "upload", host: windowsHost(remoteRoot), source, target: remote, overwrite: false });
    await terminal(manager, upload.operationId);
    const uploadSnapshot = manager.get(upload.operationId);
    if (uploadSnapshot.state === "failed") {
      expect(uploadSnapshot).toMatchObject({
        error: { code: "ATOMIC_REPLACE_UNSUPPORTED", sideEffects: "none" },
        result: { transferredBytes: 0, finalTargetCommit: "not_committed" }
      });
      expect(await exists(remote)).toBe(false);
      expect(await parts(remoteRoot)).toEqual([]);
      return;
    }
    expect(uploadSnapshot).toMatchObject({ state: "completed", result: { transferredBytes: content.length, finalTargetCommit: "committed" } });
    expect(await readFile(remote)).toEqual(content);

    const replacement = Buffer.from([7, 0, 8, 9]);
    await writeFile(source, replacement);
    const replace = service.start({ direction: "upload", host: windowsHost(remoteRoot), source, target: remote, overwrite: true });
    await terminal(manager, replace.operationId);
    const replaceSnapshot = manager.get(replace.operationId);
    if (replaceSnapshot.state === "failed") {
      expect(replaceSnapshot).toMatchObject({
        error: { code: "ATOMIC_REPLACE_UNSUPPORTED", sideEffects: "none" },
        result: { transferredBytes: 0, finalTargetCommit: "not_committed" }
      });
      expect(await readFile(remote)).toEqual(content);
      expect(await parts(remoteRoot)).toEqual([]);
      return;
    }
    expect(replaceSnapshot).toMatchObject({ state: "completed", result: { transferredBytes: replacement.length, finalTargetCommit: "committed" } });

    const receive = service.start({ direction: "download", host: windowsHost(remoteRoot), source: remote, target: download, overwrite: false });
    await terminal(manager, receive.operationId);
    expect(manager.get(receive.operationId).state).toBe("completed");
    expect(await readFile(download)).toEqual(replacement);
    expect(await parts(remoteRoot)).toEqual([]);
  });
});

function windowsHost(remoteRoot: string): HostConfig {
  return {
    alias: "windows", environment: "test", platform: "windows",
    host: required("SSH_MCP_WINDOWS_HOST"), port: Number(process.env.SSH_MCP_WINDOWS_PORT ?? "22"),
    username: required("SSH_MCP_WINDOWS_USERNAME"), auth: { type: "privateKeyFile", path: required("SSH_MCP_WINDOWS_PRIVATE_KEY") },
    shell: { type: "powershell", command: process.env.SSH_MCP_WINDOWS_POWERSHELL ?? "powershell.exe" }, remoteRoots: [remoteRoot]
  };
}
function required(name: string): string { const value = process.env[name]; if (value === undefined || value === "") throw new Error(`缺少 ${name}`); return value; }
async function exists(target: string): Promise<boolean> { try { await lstat(target); return true; } catch { return false; } }
async function parts(root: string): Promise<string[]> {
  return (await readdir(root)).filter((entry) => /^\.ssh-mcp-.*\.part$/.test(entry));
}
async function terminal(manager: OperationManager, id: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (["completed", "failed", "timed_out", "cancelled", "unknown"].includes(manager.get(id).state)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Windows 传输未在期限内结束");
}
function sequence(...ids: string[]): () => string { return () => ids.shift() ?? `extra-${Date.now()}`; }
