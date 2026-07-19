import { execFile } from "node:child_process";
import { mkdtemp, open, readFile, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testWithIds } from "../../test-with-ids.js";
import type { HostConfig } from "../../../src/config/schema.js";
import { OperationManager } from "../../../src/operations/operation-manager.js";
import { StrictHostKeyVerifier, type TrustConfirmation } from "../../../src/ssh/host-key.js";
import { SshAdapter, type SftpTransferSession, type SshConnection } from "../../../src/ssh/ssh-adapter.js";
import { TrustStore } from "../../../src/ssh/trust-store.js";
import { TransferService } from "../../../src/transfers/file-transfer.js";
import { SftpTransferBackend } from "../../../src/transfers/sftp-transfer-backend.js";

const execute = promisify(execFile);
const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/openssh-linux");
const containers: string[] = [];
let workDirectory: string;
let image: string;
let port: number;

beforeAll(async () => {
  workDirectory = await mkdtemp(join(process.cwd(), ".execute-task/ssh-mcp-transfer-integration-"));
  image = `ssh-mcp-transfer:${process.pid}-${Date.now()}`;
  await execute("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(workDirectory, "client")]);
  await execute("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(workDirectory, "host")]);
  await docker(["build", "--tag", image, fixtureDirectory]);
  const { stdout } = await docker([
    "run", "--rm", "--detach", "--publish", "127.0.0.1::22",
    "--mount", `type=bind,src=${join(workDirectory, "host")},dst=/etc/ssh/fixture_host_key,readonly`,
    "--mount", `type=bind,src=${join(workDirectory, "client.pub")},dst=/home/sshmcp/.ssh/authorized_keys,readonly`, image
  ]);
  containers.push(stdout.trim());
  const published = await docker(["port", stdout.trim(), "22/tcp"]);
  port = Number(/:(\d+)\s*$/.exec(published.stdout)?.[1]);
  await waitForPort(port);
});

afterAll(async () => {
  for (const container of containers.reverse()) await docker(["stop", "--time", "1", container]).catch(() => undefined);
  if (image !== undefined) await docker(["image", "rm", image]).catch(() => undefined);
});

describe("Linux OpenSSH SFTP 单文件传输", () => {
  testWithIds(["SC-038", "SC-041", "SC-042", "SC-045"], "上传/下载二进制内容一致，真实进度精确，并覆盖目标存在与原子替换", async () => {
    const content = Buffer.concat([Buffer.from([0, 255, 13, 10]), Buffer.from("中文\n"), Buffer.alloc(96_000, 0xa5)]);
    const localSource = join(workDirectory, "source.bin");
    const localDownload = join(workDirectory, "download.bin");
    await writeFile(localSource, content);

    const manager = new OperationManager({ idFactory: sequence("upload", "exists", "replace", "download") });
    const service = createService(manager);
    const upload = service.start({ direction: "upload", host: targetHost(), source: localSource, target: "/home/sshmcp/transfer.bin", overwrite: false });
    await terminal(manager, upload.operationId);
    expect(manager.get(upload.operationId)).toMatchObject({
      state: "completed", result: { transferredBytes: content.length, totalBytes: content.length, completedItems: 1 }
    });

    const exists = service.start({ direction: "upload", host: targetHost(), source: localSource, target: "/home/sshmcp/transfer.bin", overwrite: false });
    await terminal(manager, exists.operationId);
    expect(manager.get(exists.operationId)).toMatchObject({ state: "failed", error: { code: "TARGET_EXISTS", sideEffects: "none" } });

    const replacement = Buffer.from([9, 8, 7, 0, 6]);
    await writeFile(localSource, replacement);
    const replace = service.start({ direction: "upload", host: targetHost(), source: localSource, target: "/home/sshmcp/transfer.bin", overwrite: true });
    await terminal(manager, replace.operationId);
    expect(manager.get(replace.operationId)).toMatchObject({ state: "completed", result: { transferredBytes: replacement.length } });

    const download = service.start({ direction: "download", host: targetHost(), source: "/home/sshmcp/transfer.bin", target: localDownload, overwrite: false });
    await terminal(manager, download.operationId);
    expect(manager.get(download.operationId)).toMatchObject({ state: "completed", result: { transferredBytes: replacement.length, totalBytes: replacement.length } });
    expect(await readFile(localDownload)).toEqual(replacement);
    expect(await remoteParts()).toEqual([]);
  });

  it("真实取消停止 SFTP 流，不产生最终半文件并清理本次 .part", async () => {
    const largeSource = join(workDirectory, "large.bin");
    const handle = await open(largeSource, "w");
    await handle.truncate(512 * 1024 * 1024);
    await handle.close();
    const manager = new OperationManager({ idFactory: () => "cancel" });
    const service = createService(manager);
    const operation = service.start({ direction: "upload", host: targetHost(), source: largeSource, target: "/home/sshmcp/cancelled.bin", overwrite: false });
    await waitUntil(() => manager.get(operation.operationId).state === "running"
      && Number(manager.get(operation.operationId).result?.transferredBytes ?? 0) > 0);
    manager.cancel(operation.operationId);
    await terminal(manager, operation.operationId);
    expect(manager.get(operation.operationId)).toMatchObject({ state: "cancelled", result: { completedItems: 0, temporaryCleanup: "removed" } });
    const { stdout } = await docker(["exec", containers[0]!, "sh", "-c", "test ! -e /home/sshmcp/cancelled.bin; find /home/sshmcp -maxdepth 1 -name '.ssh-mcp-*.part' -print"]);
    expect(stdout.trim()).toBe("");
  });

  it("能力拒绝发生在写入前，确定性 commit 失败后真实远端无 final 半文件或 part", async () => {
    const source = join(workDirectory, "failure-source.bin");
    await writeFile(source, Buffer.alloc(128 * 1024, 0x5a));
    const manager = new OperationManager({ idFactory: sequence("capability-rejected", "commit-failed") });

    // 这是适配层能力夹具：真实 OpenSSH 仍负责连接、路径验证和文件状态；只把已握手能力降级为“不支持”。
    const unsupported = createService(manager, (sftp) => ({
      ...sftp,
      supportsAtomicReplace: false,
      supportsHardlink: false
    }));
    const rejected = unsupported.start({
      direction: "upload", host: targetHost(), source, target: "/home/sshmcp/capability-rejected.bin", overwrite: false
    });
    await terminal(manager, rejected.operationId);
    expect(manager.get(rejected.operationId)).toMatchObject({
      state: "failed",
      error: { code: "ATOMIC_REPLACE_UNSUPPORTED", sideEffects: "none" },
      result: { transferredBytes: 0, completedItems: 0, finalTargetCommit: "not_committed" }
    });

    // 确定性地在真正写完远端 part 后、提交前拒绝 hardlink，验证服务能清理真实 OpenSSH 文件状态。
    const commitFailure = createService(manager, (sftp) => ({
      ...sftp,
      hardlink: async () => { throw new Error("测试夹具：提交失败"); }
    }));
    const failed = commitFailure.start({
      direction: "upload", host: targetHost(), source, target: "/home/sshmcp/commit-failed.bin", overwrite: false
    });
    await terminal(manager, failed.operationId);
    expect(manager.get(failed.operationId)).toMatchObject({
      state: "unknown",
      error: { code: "STATE_UNKNOWN", sideEffects: "possible", details: { temporaryCleanup: "removed" } },
      result: { completedItems: 0, finalTargetCommit: "unknown", temporaryCleanup: "removed" }
    });
    const { stdout } = await docker([
      "exec", containers[0]!, "sh", "-c",
      "test ! -e /home/sshmcp/capability-rejected.bin; test ! -e /home/sshmcp/commit-failed.bin; find /home/sshmcp -maxdepth 1 -name '.ssh-mcp-*.part' -print"
    ]);
    expect(stdout.trim()).toBe("");
  });
});

function createService(
  manager: OperationManager,
  transformSftp?: (sftp: SftpTransferSession) => SftpTransferSession
): TransferService {
  const confirmation: TrustConfirmation = { supportsForm: () => true, confirm: async () => "accept" };
  const adapter = new SshAdapter(new StrictHostKeyVerifier(new TrustStore(join(workDirectory, "trust.json")), confirmation));
  const transferAdapter = transformSftp === undefined ? adapter : {
    connect: async (target: HostConfig): Promise<SshConnection> => {
      const connection = await adapter.connect(target);
      return {
        exec: connection.exec,
        openShell: connection.openShell,
        close: connection.close,
        ...(connection.onClose === undefined ? {} : { onClose: connection.onClose }),
        openSftp: (callback) => connection.openSftp!((error, sftp) => {
          if (error !== undefined) { callback(error, undefined as never); return; }
          callback(undefined, transformSftp(sftp));
        })
      };
    }
  };
  return new TransferService(manager, new SftpTransferBackend(transferAdapter, [workDirectory], { localPlatform: "posix" }));
}
function targetHost(): HostConfig {
  return {
    alias: "linux", environment: "test", platform: "linux", host: "127.0.0.1", port, username: "sshmcp",
    auth: { type: "privateKeyFile", path: join(workDirectory, "client") }, shell: { type: "posix", command: "/bin/sh" },
    remoteRoots: ["/home/sshmcp"]
  };
}
async function remoteParts(): Promise<string[]> {
  const { stdout } = await docker(["exec", containers[0]!, "find", "/home/sshmcp", "-maxdepth", "1", "-name", ".ssh-mcp-*.part", "-print"]);
  return stdout.trim() === "" ? [] : stdout.trim().split("\n");
}
async function terminal(manager: OperationManager, id: string): Promise<void> {
  await waitUntil(() => ["completed", "failed", "timed_out", "cancelled", "unknown"].includes(manager.get(id).state));
}
async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("传输未在期限内结束");
}
function sequence(...ids: string[]): () => string { return () => ids.shift() ?? `extra-${Date.now()}`; }
async function docker(args: string[]): Promise<{ stdout: string; stderr: string }> { return await execute("docker", args, { maxBuffer: 4 * 1024 * 1024 }); }
async function waitForPort(targetPort: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const ready = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ port: targetPort, host: "127.0.0.1" });
      socket.setTimeout(200); socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("timeout", () => { socket.destroy(); resolve(false); }); socket.once("error", () => resolve(false));
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("OpenSSH fixture 未就绪");
}
