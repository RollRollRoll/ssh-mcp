import path from "node:path";
import { lstat, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { HostConfig } from "../../../src/config/schema.js";
import { OperationManager } from "../../../src/operations/operation-manager.js";
import { StrictHostKeyVerifier, type TrustConfirmation } from "../../../src/ssh/host-key.js";
import { SshAdapter, type SftpTransferSession, type SshConnection } from "../../../src/ssh/ssh-adapter.js";
import { TrustStore } from "../../../src/ssh/trust-store.js";
import { DirectoryTransferService } from "../../../src/transfers/directory-transfer.js";
import { SftpDirectoryTransferBackend } from "../../../src/transfers/directory-transfer-backend.js";

const enabled = process.platform === "win32" && process.env.SSH_MCP_WINDOWS_INTEGRATION === "1";

describe.skipIf(!enabled)("Windows OpenSSH SFTP 递归目录传输", () => {
  it("真实覆盖嵌套目录、盘符/大小写边界及服务端原子能力分支", async () => {
    const localRoot = process.env.SSH_MCP_WINDOWS_LOCAL_ROOT ?? await mkdtemp(path.join(tmpdir(), "ssh-mcp-directory-"));
    const remoteRoot = required("SSH_MCP_WINDOWS_REMOTE_ROOT");
    const source = path.win32.join(localRoot, `Source-${process.pid}-${Date.now()}`);
    await mkdir(path.win32.join(source, "Nested", "Empty"), { recursive: true });
    const content = Buffer.concat([Buffer.from([0, 255, 13, 10]), Buffer.from("中文")]);
    await writeFile(path.win32.join(source, "Nested", "Data.bin"), content);
    const remote = path.win32.join(remoteRoot.toLocaleLowerCase("en-US"), `Directory-${process.pid}-${Date.now()}`);
    const manager = new OperationManager({ idFactory: () => "windows-directory" });
    const adapter = createAdapter(localRoot);
    const service = createService(manager, adapter, localRoot);
    const operation = service.start({ direction: "upload", host: windowsHost(remoteRoot), source, target: remote, overwrite: false, recursive: true });
    await terminal(manager, operation.operationId);
    const snapshot = manager.get(operation.operationId);
    if (snapshot.state === "partial_failure") {
      expect(snapshot).toMatchObject({
        error: { code: "PARTIAL_FAILURE", sideEffects: "partial" },
        result: { succeeded: [], failed: [{ relativePath: "Nested/Data.bin", code: "ATOMIC_REPLACE_UNSUPPORTED" }] }
      });
      await expect(remoteStat(adapter, windowsHost(remoteRoot), path.win32.join(remote, "Nested", "Data.bin")))
        .rejects.toBeDefined();
      return;
    }
    expect(snapshot).toMatchObject({ state: "completed", result: { succeeded: ["Nested/Data.bin"] } });
    expect(await remoteRead(adapter, windowsHost(remoteRoot), path.win32.join(remote, "Nested", "Data.bin"))).toEqual(content);
    await expect(remoteStat(adapter, windowsHost(remoteRoot), path.win32.join(remote, "Nested", "Empty")))
      .resolves.toMatchObject({ kind: "directory" });
  });

  it("真实远端 junction/reparse point 明确拒绝且不读取指向、不创建本地目标", async () => {
    const localRoot = process.env.SSH_MCP_WINDOWS_LOCAL_ROOT ?? await mkdtemp(path.join(tmpdir(), "ssh-mcp-remote-reparse-"));
    const remoteRoot = required("SSH_MCP_WINDOWS_REMOTE_ROOT");
    const source = path.win32.join(remoteRoot, `Remote-Reparse-${process.pid}-${Date.now()}`);
    const outside = path.win32.join(remoteRoot, `Remote-Outside-${process.pid}-${Date.now()}`);
    const junction = path.win32.join(source, "junction");
    const target = path.win32.join(localRoot, `Rejected-${process.pid}-${Date.now()}`);
    const adapter = createAdapter(localRoot);
    const targetHost = windowsHost(remoteRoot);
    await withSftp(adapter, targetHost, async (connection, sftp) => {
      await sftp.mkdir!(source);
      await sftp.mkdir!(outside);
      await writeRemote(sftp, path.win32.join(outside, "secret.txt"), Buffer.from("secret"));
      const script = `New-Item -ItemType Junction -LiteralPath '${quotePowerShell(junction)}' -Target '${quotePowerShell(outside)}' -ErrorAction Stop | Out-Null`;
      await executeRemote(connection, `${quotedExecutable(targetHost.shell.command)} -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`);
    });
    await expect(remoteStat(adapter, targetHost, junction)).resolves.toBeDefined();
    const manager = new OperationManager({ idFactory: () => "windows-reparse" });
    const service = createService(manager, adapter, localRoot);
    const operation = service.start({ direction: "download", host: targetHost, source, target, overwrite: false, recursive: true });
    await terminal(manager, operation.operationId);
    expect(manager.get(operation.operationId)).toMatchObject({ state: "failed", error: { code: "LINK_NOT_ALLOWED", sideEffects: "none" } });
    expect(await exists(target)).toBe(false);
  });
});

function createAdapter(localRoot: string): SshAdapter {
  const confirmation: TrustConfirmation = { supportsForm: () => true, confirm: async () => "accept" };
  return new SshAdapter(new StrictHostKeyVerifier(new TrustStore(path.win32.join(localRoot, "trust.json")), confirmation));
}
function createService(manager: OperationManager, adapter: SshAdapter, localRoot: string): DirectoryTransferService {
  return new DirectoryTransferService(manager, new SftpDirectoryTransferBackend(adapter, [localRoot], { localPlatform: "win32" }));
}
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
async function withSftp<T>(adapter: SshAdapter, host: HostConfig, action: (connection: SshConnection, sftp: SftpTransferSession) => Promise<T>): Promise<T> {
  const connection = await adapter.connect(host);
  const sftp = await new Promise<SftpTransferSession>((resolve, reject) => connection.openSftp!((error, value) => error === undefined ? resolve(value) : reject(error)));
  try { return await action(connection, sftp); } finally { try { sftp.close(); } finally { connection.close(); } }
}
async function remoteStat(adapter: SshAdapter, host: HostConfig, target: string) {
  return await withSftp(adapter, host, async (_connection, sftp) => await sftp.lstat(target));
}
async function remoteRead(adapter: SshAdapter, host: HostConfig, target: string): Promise<Buffer> {
  return await withSftp(adapter, host, async (_connection, sftp) => await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = sftp.createReadStream(target);
    stream.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.once("error", reject);
    stream.once("end", () => resolve(Buffer.concat(chunks)));
  }));
}
async function writeRemote(sftp: SftpTransferSession, target: string, content: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = sftp.createWriteStream(target);
    stream.once("error", reject);
    stream.once("finish", resolve);
    stream.end(content);
  });
}
async function executeRemote(connection: SshConnection, command: string): Promise<void> {
  await new Promise<void>((resolve, reject) => connection.exec(command, (error, channel) => {
    if (error !== undefined) { reject(error); return; }
    let stderr = "";
    channel.stderr.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
    channel.once("error", reject);
    channel.once("close", (code: number | null | undefined) => code === 0 ? resolve() : reject(new Error(`远端命令失败(${code ?? -1}): ${stderr}`)));
  }));
}
function quotePowerShell(value: string): string { return value.replace(/'/g, "''"); }
function quotedExecutable(value: string): string { return `"${value.replace(/"/g, '""')}"`; }
async function terminal(manager: OperationManager, id: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (["completed", "failed", "partial_failure", "timed_out", "cancelled", "unknown"].includes(manager.get(id).state)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Windows 目录传输未在期限内结束");
}
