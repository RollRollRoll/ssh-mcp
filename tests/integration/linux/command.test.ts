import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CommandRunner } from "../../../src/commands/command-runner.js";
import type { HostConfig } from "../../../src/config/schema.js";
import { OperationManager } from "../../../src/operations/operation-manager.js";
import { StrictHostKeyVerifier, type TrustConfirmation } from "../../../src/ssh/host-key.js";
import { SshAdapter } from "../../../src/ssh/ssh-adapter.js";
import { TrustStore } from "../../../src/ssh/trust-store.js";

const execute = promisify(execFile);
const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/openssh-linux");
const containers: string[] = [];
let workDirectory: string;
let image: string;
let port: number;

beforeAll(async () => {
  workDirectory = await mkdtemp(join(process.cwd(), ".execute-task/ssh-mcp-command-integration-"));
  image = `ssh-mcp-command:${process.pid}-${Date.now()}`;
  await execute("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(workDirectory, "client")]);
  await execute("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(workDirectory, "host")]);
  await docker(["build", "--tag", image, fixtureDirectory]);
  const { stdout } = await docker([
    "run", "--rm", "--detach", "--publish", "127.0.0.1::22",
    "--mount", `type=bind,src=${join(workDirectory, "host")},dst=/etc/ssh/fixture_host_key,readonly`,
    "--mount", `type=bind,src=${join(workDirectory, "client.pub")},dst=/home/sshmcp/.ssh/authorized_keys,readonly`,
    "--mount", `type=bind,src=${join(workDirectory, "client.pub")},dst=/home/sshmcpignore/.ssh/authorized_keys,readonly`,
    image
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

describe("Linux OpenSSH command", () => {
  it("真实覆盖 exit 0/非零、stdout/stderr、中文 CRLF、无效 UTF-8 与有界输出", async () => {
    const manager = new OperationManager({ idFactory: sequence("ok", "bad"), outputBufferBytes: 128 });
    const runner = createRunner(manager);
    const ok = runner.start(host(), "printf '中文\\r\\n'; printf '错误\\r\\n' >&2");
    await terminal(manager, ok.operationId);
    expect(manager.get(ok.operationId)).toMatchObject({ state: "completed", result: { exitCode: 0, stdoutBytes: 8, stderrBytes: 8 } });
    expect(manager.get(ok.operationId).frames).toEqual(expect.arrayContaining([
      expect.objectContaining({ stream: "stdout", encoding: "utf8", data: "中文\r\n" }),
      expect.objectContaining({ stream: "stderr", encoding: "utf8", data: "错误\r\n" })
    ]));

    const bad = runner.start(host(), "printf '\\377'; printf 'bad' >&2; exit 7");
    await terminal(manager, bad.operationId);
    expect(manager.get(bad.operationId)).toMatchObject({ state: "failed", error: { code: "COMMAND_FAILED" }, result: { exitCode: 7, stdoutBytes: 1, stderrBytes: 3 } });
    expect(manager.get(bad.operationId).frames).toEqual(expect.arrayContaining([expect.objectContaining({ encoding: "base64", data: "/w==" })]));

    const overflowManager = new OperationManager({ idFactory: () => "overflow", outputBufferBytes: 4 });
    const overflow = createRunner(overflowManager).start(host(), "printf 123456");
    await terminal(overflowManager, overflow.operationId);
    expect(overflowManager.get(overflow.operationId)).toMatchObject({ state: "completed", truncated: true, droppedBytes: 2, result: { stdoutBytes: 6 } });
  });

  it("TERM 被远端 close 确认后才取消", async () => {
    const confirmed = new OperationManager({ idFactory: () => "confirmed" });
    const confirmedRunner = createRunner(confirmed);
    const operation = confirmedRunner.start(host(), "printf started; trap 'exit 0' TERM; while :; do :; done");
    await outputStarted(confirmed, operation.operationId);
    expect(confirmed.cancel(operation.operationId).state).toBe("running");
    await terminal(confirmed, operation.operationId);
    expect(confirmed.get(operation.operationId).state).toBe("cancelled");
  });

  it("命令预算超时走同一 TERM 确认流程并保留 timed_out", async () => {
    const manager = new OperationManager({ idFactory: () => "timeout", limits: { commandTimeoutMs: 1_000 } });
    const runner = createRunner(manager);
    const operation = runner.start(host(), "printf started; trap 'exit 0' TERM; while :; do :; done");
    await outputStarted(manager, operation.operationId);
    await terminal(manager, operation.operationId);
    expect(manager.get(operation.operationId)).toMatchObject({
      state: "timed_out",
      error: { code: "COMMAND_TIMEOUT", finalState: "timed_out", sideEffects: "confirmed" }
    });
  });

  it("远端忽略 TERM 时，取消确认窗口到期后强制断链并保持 unknown", async () => {
    const manager = new OperationManager({
      idFactory: () => "cancel-unconfirmed",
      limits: { cancelConfirmationTimeoutMs: 500 }
    });
    const operation = createRunner(manager).start(host("sshmcpignore"), "/usr/local/bin/ignore-term");
    await outputStarted(manager, operation.operationId);

    expect(manager.cancel(operation.operationId).state).toBe("running");
    await terminal(manager, operation.operationId);
    expect(manager.get(operation.operationId)).toMatchObject({
      state: "unknown",
      error: { code: "CANCEL_UNCONFIRMED", finalState: "unknown", sideEffects: "possible" },
      result: { host: "linux", platform: "linux", stdoutBytes: 8, stderrBytes: 0 }
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(manager.get(operation.operationId).state).toBe("unknown");
  });

  it("远端忽略 TERM 时，命令超时强制断链后保持带 timeout 原因的 unknown", async () => {
    const manager = new OperationManager({
      idFactory: () => "timeout-unconfirmed",
      limits: { commandTimeoutMs: 500, cancelConfirmationTimeoutMs: 500 }
    });
    const operation = createRunner(manager).start(host("sshmcpignore"), "/usr/local/bin/ignore-term");
    await outputStarted(manager, operation.operationId);
    await terminal(manager, operation.operationId);

    expect(manager.get(operation.operationId)).toMatchObject({
      state: "unknown",
      error: {
        code: "STATE_UNKNOWN",
        finalState: "unknown",
        sideEffects: "possible",
        details: { reason: "timeout", timeoutKind: "command" }
      },
      result: { host: "linux", platform: "linux", stdoutBytes: 8, stderrBytes: 0 }
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(manager.get(operation.operationId).state).toBe("unknown");
  });
});

function createRunner(manager: OperationManager): CommandRunner {
  const confirmation: TrustConfirmation = { supportsForm: () => true, confirm: async () => "accept" };
  return new CommandRunner(new SshAdapter(new StrictHostKeyVerifier(new TrustStore(join(workDirectory, "trust.json")), confirmation)), manager);
}

function host(username = "sshmcp"): HostConfig {
  return { alias: "linux", environment: "test", platform: "linux", host: "127.0.0.1", port, username, auth: { type: "privateKeyFile", path: join(workDirectory, "client") }, shell: { type: "posix", command: "/bin/sh" }, remoteRoots: ["/tmp"] };
}

async function terminal(manager: OperationManager, id: string): Promise<void> {
  await waitUntil(() => ["completed", "failed", "timed_out", "cancelled", "unknown"].includes(manager.get(id).state));
}
async function outputStarted(manager: OperationManager, id: string): Promise<void> { await waitUntil(() => manager.get(id).nextCursor > 0); }
async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error("操作未在期限内达到预期状态");
}
function sequence(...ids: string[]): () => string { return () => ids.shift() ?? `extra-${Date.now()}`; }
async function docker(args: string[]): Promise<{ stdout: string; stderr: string }> { return await execute("docker", args, { maxBuffer: 4 * 1024 * 1024 }); }
async function waitForPort(targetPort: number): Promise<void> {
  await waitUntilPort(targetPort, Date.now() + 10_000);
}
async function waitUntilPort(targetPort: number, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ port: targetPort, host: "127.0.0.1" });
      socket.setTimeout(200); socket.once("connect", () => { socket.destroy(); resolve(true); }); socket.once("timeout", () => { socket.destroy(); resolve(false); }); socket.once("error", () => resolve(false));
    });
    if (open) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("OpenSSH fixture 未就绪");
}
