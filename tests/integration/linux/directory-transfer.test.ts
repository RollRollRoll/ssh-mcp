import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testWithIds } from "../../test-with-ids.js";
import type { HostConfig } from "../../../src/config/schema.js";
import { OperationManager } from "../../../src/operations/operation-manager.js";
import { StrictHostKeyVerifier, type TrustConfirmation } from "../../../src/ssh/host-key.js";
import { SshAdapter, type SftpTransferSession, type SshConnection } from "../../../src/ssh/ssh-adapter.js";
import { TrustStore } from "../../../src/ssh/trust-store.js";
import { DirectoryTransferService } from "../../../src/transfers/directory-transfer.js";
import { SftpDirectoryTransferBackend } from "../../../src/transfers/directory-transfer-backend.js";

const execute = promisify(execFile);
const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/openssh-linux");
const containers: string[] = [];
let workDirectory: string;
let image: string;
let port: number;

beforeAll(async () => {
  workDirectory = await mkdtemp(join(process.cwd(), ".execute-task/ssh-mcp-directory-integration-"));
  image = `ssh-mcp-directory:${process.pid}-${Date.now()}`;
  await execute("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(workDirectory, "client")]);
  await execute("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(workDirectory, "host")]);
  await docker(["build", "--tag", image, fixtureDirectory]);
  const { stdout } = await docker([
    "run", "--rm", "--detach", "--publish", "127.0.0.1::22",
    "--mount", `type=bind,src=${join(workDirectory, "host")},dst=/etc/ssh/fixture_host_key,readonly`,
    "--mount", `type=bind,src=${join(workDirectory, "client.pub")},dst=/home/sshmcp/.ssh/authorized_keys,readonly`,
    "--mount", "type=tmpfs,dst=/home/sshmcp/mount-tree/child,tmpfs-mode=0755", image
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

describe("Linux OpenSSH SFTP 递归目录传输", () => {
  testWithIds(["SC-039"], "上传和下载嵌套空目录/二进制，顺序稳定且目标目录存在时 overwrite false/true 都拒绝", async () => {
    const source = join(workDirectory, "tree-source");
    await mkdir(join(source, "a", "empty"), { recursive: true });
    await mkdir(join(source, "z-empty"), { recursive: true });
    const binary = Buffer.concat([Buffer.from([0, 255, 13, 10]), Buffer.from("中文"), Buffer.alloc(48_000, 0xa5)]);
    await writeFile(join(source, "a", "two.bin"), binary);
    await writeFile(join(source, "one.txt"), "one");

    const manager = new OperationManager({ idFactory: sequence("upload", "exists-false", "exists-true", "download") });
    const service = createService(manager);
    const upload = service.start(request("upload", source, "/home/sshmcp/tree", false));
    await terminal(manager, upload.operationId);
    expect(manager.get(upload.operationId)).toMatchObject({
      state: "completed",
      result: {
        succeeded: ["a/two.bin", "one.txt"], failed: [], notExecuted: [],
        aggregateTransferredBytes: binary.length + 3, completedItems: 2, totalItems: 2
      }
    });
    const remote = await docker(["exec", containers[0]!, "sh", "-c",
      "test -d /home/sshmcp/tree/a/empty; test -d /home/sshmcp/tree/z-empty; find /home/sshmcp/tree -type f -print | sort"]);
    expect(remote.stdout.trim().split("\n")).toEqual(["/home/sshmcp/tree/a/two.bin", "/home/sshmcp/tree/one.txt"]);

    for (const overwrite of [false, true]) {
      const exists = service.start(request("upload", source, "/home/sshmcp/tree", overwrite));
      await terminal(manager, exists.operationId);
      expect(manager.get(exists.operationId)).toMatchObject({ state: "failed", error: { code: "TARGET_EXISTS", sideEffects: "none" } });
    }

    const downloaded = join(workDirectory, "downloaded-tree");
    const download = service.start(request("download", "/home/sshmcp/tree", downloaded, false));
    await terminal(manager, download.operationId);
    expect(manager.get(download.operationId)).toMatchObject({ state: "completed", result: { succeeded: ["a/two.bin", "one.txt"] } });
    expect(await readFile(join(downloaded, "a", "two.bin"))).toEqual(binary);
    expect(await readFile(join(downloaded, "one.txt"), "utf8")).toBe("one");
    const emptyCheck = await execute("test", ["-d", join(downloaded, "a", "empty")]);
    expect(emptyCheck.stderr).toBe("");
  });

  testWithIds(["SC-043", "MN-009"], "拒绝链接；同一目标重试从零开始且结果不宣称保留元数据", async () => {
    const source = join(workDirectory, "link-source");
    const outside = join(workDirectory, "outside-secret");
    await mkdir(source);
    await writeFile(outside, "不可读取");
    await symlink(outside, join(source, "link"));
    const manager = new OperationManager({ idFactory: () => "link" });
    const service = createService(manager);
    const operation = service.start(request("upload", source, "/home/sshmcp/link-target", false));
    await terminal(manager, operation.operationId);
    expect(manager.get(operation.operationId)).toMatchObject({ state: "failed", error: { code: "LINK_NOT_ALLOWED", sideEffects: "none" } });
    const check = await docker(["exec", containers[0]!, "test", "!", "-e", "/home/sshmcp/link-target"]);
    expect(check.stdout).toBe("");

    const retrySource = join(workDirectory, "restart-source");
    const retryBytes = Buffer.alloc(64 * 1024 * 1024, 0x6d);
    await mkdir(retrySource);
    await writeFile(join(retrySource, "whole.bin"), retryBytes);
    const retryManager = new OperationManager({ idFactory: sequence("interrupted", "restarted") });
    const retryService = createService(retryManager);
    const retryTarget = "/home/sshmcp/retry-tree";
    const interrupted = retryService.start(request("upload", retrySource, retryTarget, false));
    await waitUntil(() => Number(retryManager.get(interrupted.operationId).result?.transferredBytes ?? 0) > 0);
    retryManager.cancel(interrupted.operationId);
    await terminal(retryManager, interrupted.operationId);
    expect(retryManager.get(interrupted.operationId)).toMatchObject({
      state: "cancelled", result: { succeeded: [], stopRequested: true, stopReason: "cancel" }
    });

    const interruptedCheck = await docker(["exec", containers[0]!, "test", "!", "-e", `${retryTarget}/whole.bin`]);
    expect(interruptedCheck.stdout).toBe("");
    await docker(["exec", containers[0]!, "rmdir", retryTarget]);

    const restarted = retryService.start(request("upload", retrySource, retryTarget, false));
    await terminal(retryManager, restarted.operationId);
    const restartedSnapshot = retryManager.get(restarted.operationId);
    expect(restartedSnapshot).toMatchObject({
      state: "completed",
      result: {
        succeeded: ["whole.bin"],
        aggregateTransferredBytes: retryBytes.length,
        transferredBytes: retryBytes.length,
        totalBytes: retryBytes.length
      }
    });
    assertNoMetadataClaims(restartedSnapshot.result!);
    const retryCheck = await docker(["exec", containers[0]!, "sh", "-c",
      "test $(wc -c < /home/sshmcp/retry-tree/whole.bin) -eq 67108864"]);
    expect(retryCheck.stderr).toBe("");
  });

  it("真实拒绝批准根及根内子挂载点，且不创建本地目标", async () => {
    for (const [suffix, source] of [
      ["child", "/home/sshmcp/mount-tree"],
      ["root", "/home/sshmcp/mount-tree/child"]
    ] as const) {
      const target = join(workDirectory, `mount-rejected-${suffix}`);
      const manager = new OperationManager({ idFactory: () => `mount-rejected-${suffix}` });
      const service = createService(manager);
      const operation = service.start(request("download", source, target, false));
      await terminal(manager, operation.operationId);
      expect(manager.get(operation.operationId)).toMatchObject({
        state: "failed", error: { code: "PATH_DENIED", sideEffects: "none" }
      });
      await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  testWithIds(["SC-044"], "确定性中途失败后列出 succeeded/failed/notExecuted，保留完成文件且无半文件", async () => {
    const source = join(workDirectory, "failure-source");
    await mkdir(source);
    await writeFile(join(source, "a.bin"), Buffer.alloc(128 * 1024, 0x11));
    await writeFile(join(source, "b.bin"), Buffer.alloc(128 * 1024, 0x22));
    await writeFile(join(source, "c.bin"), Buffer.alloc(128 * 1024, 0x33));
    let writes = 0;
    const manager = new OperationManager({ idFactory: () => "partial" });
    const service = createService(manager, (sftp) => ({
      ...sftp,
      createWriteStream: (target) => {
        writes += 1;
        if (writes === 2) {
          return new Writable({ write: (_chunk, _encoding, callback) => callback(new Error("确定性写入失败")) });
        }
        return sftp.createWriteStream(target);
      }
    }));
    const operation = service.start(request("upload", source, "/home/sshmcp/failure-target", false));
    await terminal(manager, operation.operationId);
    expect(manager.get(operation.operationId)).toMatchObject({
      state: "partial_failure",
      result: {
        succeeded: ["a.bin"], failed: [{ relativePath: "b.bin", code: "TRANSFER_FAILED", safety: "confirmed" }], notExecuted: ["c.bin"]
      }
    });
    const check = await docker(["exec", containers[0]!, "sh", "-c",
      "test -f /home/sshmcp/failure-target/a.bin; test ! -e /home/sshmcp/failure-target/b.bin; test ! -e /home/sshmcp/failure-target/c.bin; find /home/sshmcp/failure-target -name '.ssh-mcp-*.part' -print"]);
    expect(check.stdout.trim()).toBe("");
  });

  it("真实取消当前大文件后不启动后续项并清理半文件", async () => {
    const source = join(workDirectory, "cancel-source");
    await mkdir(source);
    await writeFile(join(source, "a-large.bin"), Buffer.alloc(64 * 1024 * 1024, 0x55));
    await writeFile(join(source, "b.bin"), "never");
    const manager = new OperationManager({ idFactory: () => "cancel-directory" });
    const service = createService(manager);
    const operation = service.start(request("upload", source, "/home/sshmcp/cancel-tree", false));
    await waitUntil(() => Number(manager.get(operation.operationId).result?.transferredBytes ?? 0) > 0);
    manager.cancel(operation.operationId);
    await terminal(manager, operation.operationId);
    expect(manager.get(operation.operationId)).toMatchObject({
      state: "cancelled", result: { succeeded: [], notExecuted: ["b.bin"], stopRequested: true, stopReason: "cancel" }
    });
    const check = await docker(["exec", containers[0]!, "sh", "-c",
      "test ! -e /home/sshmcp/cancel-tree/a-large.bin; test ! -e /home/sshmcp/cancel-tree/b.bin; find /home/sshmcp/cancel-tree -name '.ssh-mcp-*.part' -print"]);
    expect(check.stdout.trim()).toBe("");
  });
});

function createService(manager: OperationManager, transformSftp?: (sftp: SftpTransferSession) => SftpTransferSession): DirectoryTransferService {
  const confirmation: TrustConfirmation = { supportsForm: () => true, confirm: async () => "accept" };
  const adapter = new SshAdapter(new StrictHostKeyVerifier(new TrustStore(join(workDirectory, "trust.json")), confirmation));
  const transferAdapter = transformSftp === undefined ? adapter : {
    connect: async (target: HostConfig): Promise<SshConnection> => {
      const connection = await adapter.connect(target);
      return {
        exec: connection.exec, openShell: connection.openShell, close: connection.close,
        ...(connection.onClose === undefined ? {} : { onClose: connection.onClose }),
        openSftp: (callback) => connection.openSftp!((error, sftp) => {
          if (error !== undefined) { callback(error, undefined as never); return; }
          callback(undefined, transformSftp(sftp));
        })
      };
    }
  };
  return new DirectoryTransferService(manager, new SftpDirectoryTransferBackend(transferAdapter, [workDirectory], { localPlatform: "posix" }));
}
function request(direction: "upload" | "download", source: string, target: string, overwrite: boolean) {
  return { direction, host: targetHost(), source, target, overwrite, recursive: true } as const;
}
function targetHost(): HostConfig {
  return {
    alias: "linux", environment: "test", platform: "linux", host: "127.0.0.1", port, username: "sshmcp",
    auth: { type: "privateKeyFile", path: join(workDirectory, "client") }, shell: { type: "posix", command: "/bin/sh" }, remoteRoots: ["/home/sshmcp"]
  };
}
async function terminal(manager: OperationManager, id: string): Promise<void> {
  await waitUntil(() => ["completed", "failed", "partial_failure", "timed_out", "cancelled", "unknown"].includes(manager.get(id).state));
}
async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("目录传输未在期限内结束");
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

function assertNoMetadataClaims(value: unknown, path = "result"): void {
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    expect(key, `${path}.${key} 不得宣称保留元数据`).not.toMatch(/permission|mode|mtime|timestamp|owner|uid|gid|metadata|attributes|preserv/i);
    assertNoMetadataClaims(nested, `${path}.${key}`);
  }
}
