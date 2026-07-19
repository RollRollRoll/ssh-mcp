import path from "node:path";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildCommand } from "../../../src/commands/command-builder.js";
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

  it("IT-WINDOWS-CANCEL-FILE-01：真实 SFTP 下载由 OperationManager.cancel 停止且不留下最终文件或 part", async () => {
    const localRoot = process.env.SSH_MCP_WINDOWS_LOCAL_ROOT ?? await mkdtemp(path.join(tmpdir(), "ssh-mcp-transfer-cancel-"));
    const remoteRoot = required("SSH_MCP_WINDOWS_REMOTE_ROOT");
    const remoteSource = path.win32.join(remoteRoot, `Cancel-Source-${process.pid}-${Date.now()}.bin`);
    const localTarget = path.win32.join(localRoot, `cancelled-${process.pid}-${Date.now()}.bin`);
    const host = windowsHost(remoteRoot);
    const manager = new OperationManager({
      idFactory: () => "windows-file-cancel",
      limits: { cancelConfirmationTimeoutMs: 10_000 }
    });
    const confirmation: TrustConfirmation = { supportsForm: () => true, confirm: async () => "accept" };
    const adapter = new SshAdapter(
      new StrictHostKeyVerifier(new TrustStore(path.win32.join(localRoot, "cancel-trust.json")), confirmation)
    );
    const service = new TransferService(manager, new SftpTransferBackend(adapter, [localRoot], { localPlatform: "win32" }));

    await executeRemotePowerShell(adapter, host, [
      `$file = [IO.File]::Open('${quotePowerShell(remoteSource)}', [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)`,
      "try { $file.SetLength(1073741824) } finally { $file.Dispose() }"
    ].join("; "));
    try {
      const operation = service.start({
        direction: "download", host, source: remoteSource, target: localTarget, overwrite: false
      });
      await waitForTransferStart(manager, operation.operationId);

      expect(manager.cancel(operation.operationId).state).toBe("running");
      await terminal(manager, operation.operationId);
      expect(manager.get(operation.operationId)).toMatchObject({
        state: "cancelled",
        result: {
          completedItems: 0,
          temporaryCleanup: "removed",
          finalTargetCommit: "not_committed",
          stopRequested: true,
          stopReason: "cancel"
        }
      });
      expect(await exists(localTarget)).toBe(false);
      expect(await parts(localRoot)).toEqual([]);
    } finally {
      await executeRemotePowerShell(
        adapter,
        host,
        `Remove-Item -LiteralPath '${quotePowerShell(remoteSource)}' -Force -ErrorAction SilentlyContinue`
      );
      await rm(localTarget, { force: true });
    }
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
async function waitForTransferStart(manager: OperationManager, operationId: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const snapshot = manager.get(operationId);
    if (snapshot.state === "running" && Number(snapshot.result?.transferredBytes ?? 0) > 0) return;
    if (["completed", "failed", "timed_out", "cancelled", "unknown"].includes(snapshot.state)) {
      throw new Error(`Windows SFTP 在取消前已终结为 ${snapshot.state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Windows SFTP 取消用例未在期限内开始传输");
}
async function executeRemotePowerShell(adapter: SshAdapter, host: HostConfig, script: string): Promise<void> {
  const connection = await adapter.connect(host);
  try {
    await new Promise<void>((resolve, reject) => connection.exec(buildCommand(host, script), (error, channel) => {
      if (error !== undefined) { reject(error); return; }
      let stderr = "";
      let settled = false;
      channel.stderr.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
      channel.on("error", (channelError) => {
        if (settled) return;
        settled = true;
        reject(channelError);
      });
      channel.on("close", (code: number | null | undefined) => {
        if (settled) return;
        settled = true;
        if (code === 0) resolve();
        else reject(new Error(`Windows 远端 PowerShell 失败(${code ?? -1}): ${stderr}`));
      });
    }));
  } finally {
    connection.close();
  }
}
function quotePowerShell(value: string): string { return value.replace(/'/g, "''"); }
function sequence(...ids: string[]): () => string { return () => ids.shift() ?? `extra-${Date.now()}`; }
