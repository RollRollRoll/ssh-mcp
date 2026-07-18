import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HostConfig } from "../../../src/config/schema.js";
import { SessionManager } from "../../../src/sessions/session-manager.js";
import { StrictHostKeyVerifier, type TrustConfirmation } from "../../../src/ssh/host-key.js";
import { SshAdapter } from "../../../src/ssh/ssh-adapter.js";
import { TrustStore } from "../../../src/ssh/trust-store.js";

class Clock {
  private sequence = 0;
  private readonly timers = new Map<number, { delayMs: number; callback: () => void }>();
  public now(): number { return 0; }
  public setTimeout(callback: () => void, delayMs: number): number { const id = ++this.sequence; this.timers.set(id, { delayMs, callback }); return id; }
  public clearTimeout(timer: unknown): void { this.timers.delete(timer as number); }
  public fire(delayMs: number): void { for (const [id, timer] of [...this.timers]) if (timer.delayMs === delayMs) { this.timers.delete(id); timer.callback(); } }
}

const execute = promisify(execFile);
const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/openssh-linux");
const containers: string[] = [];
let workDirectory: string;
let image: string;
let port: number;

beforeAll(async () => {
  workDirectory = await mkdtemp(join(process.cwd(), ".execute-task/ssh-mcp-session-integration-"));
  image = `ssh-mcp-session:${process.pid}-${Date.now()}`;
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
  await waitUntilPort(port);
});

afterAll(async () => {
  for (const container of containers.reverse()) await docker(["stop", "--time", "1", container]).catch(() => undefined);
  if (image !== undefined) await docker(["image", "rm", image]).catch(() => undefined);
});

describe("Linux OpenSSH session PTY 会话", () => {
  it("真实启动登记 bash，保持 cwd/env，应用远端尺寸并隔离两个独占 Shell", async () => {
    const manager = new SessionManager({ idFactory: sequence("session-a", "session-b") });
    const adapter = createAdapter();
    const first = await open(manager, adapter, host(), "session-a");
    const second = await open(manager, adapter, host(), "session-b");

    manager.resize(first, 120, 50);
    await manager.write(first, Buffer.from("cd /tmp; export SSH_MCP_SESSION='中文-A'; printf 'A:%s:%s:%s\n' \"$PWD\" \"$SSH_MCP_SESSION\" \"$(ps -p $$ -o comm= | tr -d ' ')\"; stty size\n"));
    await outputContains(manager, first, "A:/tmp:中文-A");
    await outputContains(manager, first, "A:/tmp:中文-A:bash");
    await outputContains(manager, first, "50 120");

    // 直接送入 base64 解码后的 Ctrl-C；服务不会自行猜测或注入该控制字符，Shell 仍可继续交互。
    await manager.write(first, Buffer.from("sleep 5\n"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await manager.write(first, Buffer.from([0x03]));
    await manager.write(first, Buffer.from("printf 'after-control-A\\n'\n"));
    await manager.write(second, Buffer.from("printf 'B:%s\\n' \"$SSH_MCP_SESSION\"\n"));
    await outputContains(manager, first, "after-control-A");
    await outputContains(manager, second, "B:");

    const firstOutput = rendered(manager, first);
    const secondOutput = rendered(manager, second);
    expect(firstOutput).toContain("中文-A");
    expect(secondOutput).not.toContain("中文-A");
    expect(manager.get(first).columns).toBe(120);
    expect(manager.get(first).rows).toBe(50);

    // exit 是远端主动断连，不会恢复会话，记录保持可读取但不再写入。
    await manager.write(first, Buffer.from("exit\n"));
    await waitUntil(() => manager.get(first).state === "disconnected");
    expect(manager.get(first).frames.some((frame) => frame.stream === "pty")).toBe(true);
    await close(manager, second);
  });

  it("真实 OpenSSH Channel 代理可确定性抑制 close 确认，强制关闭保持 unknown", async () => {
    const clock = new Clock();
    const manager = new SessionManager({ clock, idFactory: () => "forced", closeConfirmationTimeoutMs: 10 });
    const target = host();
    const reserved = manager.reserve({ host: target.alias, platform: target.platform, shell: target.shell.type, columns: 80, rows: 24 });
    const connection = await createAdapter().connect(target);
    const real = await new Promise<Parameters<SessionManager["activate"]>[2]>((resolve, reject) => {
      connection.openShell(80, 24, target.shell.command, (error, value) => error === undefined ? resolve(value as Parameters<SessionManager["activate"]>[2]) : reject(error));
    });
    const proxy = suppressClose(real);
    manager.activate(reserved.sessionId, connection, proxy);
    expect(manager.close(reserved.sessionId).state).toBe("closing");
    clock.fire(10);
    expect(manager.get(reserved.sessionId).state).toBe("unknown");
  });
});

function createAdapter(): SshAdapter {
  const confirmation: TrustConfirmation = { supportsForm: () => true, confirm: async () => "accept" };
  return new SshAdapter(new StrictHostKeyVerifier(new TrustStore(join(workDirectory, "trust.json")), confirmation));
}

function host(): HostConfig {
  return { alias: "linux", environment: "test", platform: "linux", host: "127.0.0.1", port, username: "sshmcp", auth: { type: "privateKeyFile", path: join(workDirectory, "client") }, shell: { type: "posix", command: "/bin/bash" }, remoteRoots: ["/tmp"] };
}

async function open(manager: SessionManager, adapter: SshAdapter, target: HostConfig, expectedId: string): Promise<string> {
  const reserved = manager.reserve({ host: target.alias, platform: target.platform, shell: target.shell.type, columns: 80, rows: 24 });
  expect(reserved.sessionId).toBe(expectedId);
  const connection = await adapter.connect(target);
  try {
    const channel = await new Promise<Parameters<SessionManager["activate"]>[2]>((resolve, reject) => {
      connection.openShell(80, 24, target.shell.command, (error, value) => error === undefined ? resolve(value as Parameters<SessionManager["activate"]>[2]) : reject(error));
    });
    manager.activate(reserved.sessionId, connection, channel);
    return reserved.sessionId;
  } catch (error: unknown) {
    connection.close();
    manager.abandonOpening(reserved.sessionId);
    throw error;
  }
}

async function close(manager: SessionManager, id: string): Promise<void> {
  manager.close(id);
  await waitUntil(() => manager.get(id).state === "closed");
}
function rendered(manager: SessionManager, id: string): string {
  return manager.get(id, 0, 262_144).frames.map((frame) => frame.encoding === "utf8" ? frame.data : Buffer.from(frame.data, "base64").toString("latin1")).join("");
}
async function outputContains(manager: SessionManager, id: string, text: string): Promise<void> { await waitUntil(() => rendered(manager, id).includes(text)); }
async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error("PTY 会话未在期限内达到预期状态");
}
function sequence(...ids: string[]): () => string { return () => ids.shift() ?? `extra-${Date.now()}`; }
function suppressClose(channel: Parameters<SessionManager["activate"]>[2]): Parameters<SessionManager["activate"]>[2] {
  const listeners = new Map<string, Array<(...args: readonly unknown[]) => void>>();
  const relay = (event: "data" | "error" | "exit") => (...args: readonly unknown[]): void => {
    for (const listener of listeners.get(event) ?? []) listener(...args);
  };
  channel.on("data", relay("data") as never);
  channel.on("error", relay("error") as never);
  channel.on("exit", relay("exit") as never);
  let proxy: Parameters<SessionManager["activate"]>[2];
  proxy = {
    stderr: channel.stderr,
    write: (data, callback) => channel.write(data, callback), setWindow: (...args) => channel.setWindow(...args), close: () => channel.close(),
    on: (event, listener) => { if (event !== "close") listeners.set(event, [...(listeners.get(event) ?? []), listener]); return proxy; },
    once: (event, listener) => { if (event !== "close") listeners.set(event, [...(listeners.get(event) ?? []), listener]); return proxy; },
    removeListener: (event, listener) => { listeners.set(event, (listeners.get(event) ?? []).filter((item) => item !== listener)); return proxy; }
  } as Parameters<SessionManager["activate"]>[2];
  return proxy;
}
async function docker(args: string[]): Promise<{ stdout: string; stderr: string }> { return await execute("docker", args, { maxBuffer: 4 * 1024 * 1024 }); }
async function waitUntilPort(targetPort: number): Promise<void> {
  const deadline = Date.now() + 10_000;
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
