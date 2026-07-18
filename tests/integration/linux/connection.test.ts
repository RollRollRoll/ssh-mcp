import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HostConfig } from "../../../src/config/schema.js";
import { ErrorCodes } from "../../../src/errors/error-codes.js";
import { StrictHostKeyVerifier, type TrustConfirmation } from "../../../src/ssh/host-key.js";
import { SshAdapter } from "../../../src/ssh/ssh-adapter.js";
import { TrustStore } from "../../../src/ssh/trust-store.js";

const execute = promisify(execFile);
const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/openssh-linux");
const containers: string[] = [];
let workDirectory: string;
let image: string;
let port: number;
let activeContainer: string;

beforeAll(async () => {
  workDirectory = await mkdtemp(join(process.cwd(), ".execute-task/ssh-mcp-linux-integration-"));
  image = `ssh-mcp-openssh:${process.pid}-${Date.now()}`;
  await generateKey("client");
  await generateKey("wrong-client");
  await generateKey("host-one");
  await generateKey("host-two");
  await docker(["build", "--tag", image, fixtureDirectory]);
  activeContainer = await startContainer("host-one");
  port = await publishedPort(activeContainer);
  await waitForPort(port);
});

afterAll(async () => {
  for (const container of containers.reverse()) {
    await docker(["stop", "--time", "1", container]).catch(() => undefined);
  }
  if (image !== undefined) {
    await docker(["image", "rm", image]).catch(() => undefined);
  }
});

describe("Linux OpenSSH connection", () => {
  it("覆盖首次信任、一致信任、主机密钥变化、认证成功/失败与连接超时", async () => {
    const trustStore = new TrustStore(join(workDirectory, "trust.json"));
    let confirmations = 0;
    const accepting: TrustConfirmation = {
      supportsForm: () => true,
      confirm: async () => {
        confirmations += 1;
        return "accept";
      }
    };
    const config = connectionConfig(join(workDirectory, "client"));

    const first = await new SshAdapter(new StrictHostKeyVerifier(trustStore, accepting)).connect(config);
    first.close();
    expect(confirmations).toBe(1);

    const consistent = await new SshAdapter(new StrictHostKeyVerifier(trustStore, {
      supportsForm: () => true,
      confirm: async () => {
        throw new Error("一致信任不应再次确认");
      }
    })).connect(config);
    consistent.close();
    expect(confirmations).toBe(1);

    await expect(new SshAdapter(new StrictHostKeyVerifier(trustStore, accepting)).connect(
      connectionConfig(join(workDirectory, "wrong-client"))
    )).rejects.toMatchObject({ code: ErrorCodes.AUTH_FAILED });

    await docker(["stop", "--time", "1", activeContainer]);
    activeContainer = await startContainer("host-two", port);
    await waitForPort(port);
    await expect(new SshAdapter(new StrictHostKeyVerifier(trustStore, accepting)).connect(config))
      .rejects.toMatchObject({ code: ErrorCodes.HOST_KEY_CHANGED });
    expect(confirmations).toBe(1);

    const blackhole = await startBlackhole();
    await expect(new SshAdapter(new StrictHostKeyVerifier(trustStore, accepting)).connect(
      { ...config, host: "127.0.0.1", port: blackhole.port },
      50
    )).rejects.toMatchObject({ code: ErrorCodes.CONNECTION_TIMEOUT });
    await blackhole.close();
  });
});

function connectionConfig(privateKeyPath: string): HostConfig {
  return {
    alias: "linux-fixture",
    environment: "test",
    platform: "linux",
    host: "127.0.0.1",
    port,
    username: "sshmcp",
    auth: { type: "privateKeyFile", path: privateKeyPath },
    shell: { type: "posix", command: "/bin/sh" },
    remoteRoots: ["/tmp"]
  };
}

async function generateKey(name: string): Promise<void> {
  await execute("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(workDirectory, name)]);
}

async function startContainer(hostKey: string, fixedPort?: number): Promise<string> {
  const publish = fixedPort === undefined ? "127.0.0.1::22" : `127.0.0.1:${fixedPort}:22`;
  const { stdout } = await docker([
    "run", "--rm", "--detach", "--publish", publish,
    "--mount", `type=bind,src=${join(workDirectory, `${hostKey}`)},dst=/etc/ssh/fixture_host_key,readonly`,
    "--mount", `type=bind,src=${join(workDirectory, "client.pub")},dst=/home/sshmcp/.ssh/authorized_keys,readonly`,
    image
  ]);
  const id = stdout.trim();
  containers.push(id);
  return id;
}

async function publishedPort(container: string): Promise<number> {
  const { stdout } = await docker(["port", container, "22/tcp"]);
  const match = /:(\d+)\s*$/.exec(stdout);
  if (match === null) throw new Error(`无法解析 Docker 发布端口：${stdout}`);
  return Number(match[1]);
}

async function docker(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await execute("docker", args, { maxBuffer: 4 * 1024 * 1024 });
}

async function waitForPort(targetPort: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ port: targetPort, host: "127.0.0.1" });
      socket.setTimeout(200);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
      socket.once("error", () => resolve(false));
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`OpenSSH fixture 未在端口 ${targetPort} 就绪`);
}

async function startBlackhole(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("无法取得测试端口");
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    }
  };
}
