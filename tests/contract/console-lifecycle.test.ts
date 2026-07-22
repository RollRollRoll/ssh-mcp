import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { JsonLogger } from "../../src/observability/logger.js";
import { startServer, type ServerRuntime } from "../../src/server.js";
import { testWithIds } from "../test-with-ids.js";

const configPath = join(mkdtempSync(join(tmpdir(), "ssh-mcp-console-lifecycle-")), "config.yml");
writeFileSync(configPath, `
version: 1
trustStore: /tmp/ssh-mcp-console-lifecycle-trust.json
localRoots: [/tmp]
limits:
  cancelConfirmationTimeoutMs: 50
hosts:
  - alias: local-test
    environment: test
    platform: linux
    host: 192.0.2.20
    port: 22
    username: tester
    auth: { type: pageant }
    shell: { type: posix, command: /bin/sh }
    remoteRoots: [/srv/test]
`);

interface Instance {
  readonly runtime: ServerRuntime;
  readonly accessUrl: URL;
  readonly cookie: string;
  readonly clientTransport: ReturnType<typeof InMemoryTransport.createLinkedPair>[0];
}

describe("控制台实例生命周期", () => {
  const instances: Instance[] = [];
  afterEach(async () => {
    await Promise.allSettled(instances.splice(0).map(async (instance) => {
      await instance.runtime.shutdown();
      await instance.clientTransport.close();
    }));
  });

  testWithIds(["LC-SC-001", "LC-SC-002", "LC-AC-001", "LC-AC-002"],
    "两个真实实例的 Origin、Cookie、状态与审批完全隔离", async () => {
    const first = await startInstance();
    const second = await startInstance();
    instances.push(first, second);
    expect(first.accessUrl.origin).not.toBe(second.accessUrl.origin);
    expect(first.accessUrl.hash).not.toBe(second.accessUrl.hash);
    expect(first.cookie).not.toBe(second.cookie);

    const firstSnapshot = await snapshot(first);
    const secondSnapshot = await snapshot(second);
    expect(firstSnapshot.instanceId).not.toBe(secondSnapshot.instanceId);
    expect(firstSnapshot.approvals).toEqual([]);
    expect(secondSnapshot.approvals).toEqual([]);

    const crossed = await send(Number(second.accessUrl.port), {
      path: "/api/v1/snapshot", host: second.accessUrl.host,
      headers: readHeaders(first.cookie)
    });
    expect(crossed.status).toBe(401);

    const preview = await post(first, "/api/v1/previews/command", {
      host: "local-test", command: "echo instance-one"
    });
    expect(preview.status).toBe(201);
    expect((await snapshot(first)).approvals).toHaveLength(1);
    expect((await snapshot(second)).approvals).toHaveLength(0);
  });

  testWithIds(["LC-SC-004", "LC-SC-010"],
    "统一关闭先向 SSE 发送 offline，随后旧 URL 失效且其他实例继续可用", async () => {
    const first = await startInstance();
    const second = await startInstance();
    instances.push(first, second);
    const stream = await openEventStream(first);
    await stream.waitFor("event: ready");
    await post(first, "/api/v1/previews/command", { host: "local-test", command: "echo never" });

    const shutdown = first.runtime.shutdown();
    await stream.waitFor("event: offline");
    await stream.ended;
    await shutdown;
    await expect(send(Number(first.accessUrl.port), {
      path: "/api/v1/snapshot", host: first.accessUrl.host, headers: readHeaders(first.cookie)
    })).rejects.toThrow();
    expect((await snapshot(second)).serviceState).toBe("active");
  });
});

async function startInstance(): Promise<Instance> {
  const lines: string[] = [];
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const runtime = await startServer(configPath, {
    transport: serverTransport,
    adapter: { connect: async () => { throw new Error("测试不得连接 SSH"); }, shutdown: () => undefined },
    logger: new JsonLogger({ write: (line) => lines.push(line) }),
    shutdownTimeoutMs: 50
  });
  const ready = lines.map((line) => JSON.parse(line) as { event: string; accessUrl?: string })
    .filter((record) => record.event === "console.ready");
  expect(ready).toHaveLength(1);
  const accessUrl = new URL(ready[0]!.accessUrl!);
  const token = new URLSearchParams(accessUrl.hash.slice(1)).get("access_token")!;
  const exchange = await send(Number(accessUrl.port), {
    method: "POST", path: "/api/v1/session", host: accessUrl.host,
    headers: {
      origin: accessUrl.origin, "sec-fetch-site": "same-origin", "content-type": "application/json",
      "x-ssh-mcp-request": "1"
    }, body: JSON.stringify({ accessToken: token })
  });
  expect(exchange.status).toBe(204);
  const cookie = String(exchange.headers["set-cookie"]?.[0]).split(";")[0]!;
  return { runtime, accessUrl, cookie, clientTransport };
}

async function snapshot(instance: Instance): Promise<{
  readonly instanceId: string;
  readonly serviceState: string;
  readonly approvals: readonly unknown[];
}> {
  const response = await send(Number(instance.accessUrl.port), {
    path: "/api/v1/snapshot", host: instance.accessUrl.host, headers: readHeaders(instance.cookie)
  });
  expect(response.status).toBe(200);
  return JSON.parse(response.body);
}

async function post(instance: Instance, path: string, body: unknown) {
  return await send(Number(instance.accessUrl.port), {
    method: "POST", path, host: instance.accessUrl.host,
    headers: {
      origin: instance.accessUrl.origin, "sec-fetch-site": "same-origin", "content-type": "application/json",
      "x-ssh-mcp-request": "1", cookie: instance.cookie
    }, body: JSON.stringify(body)
  });
}

function readHeaders(cookie: string): Record<string, string> {
  return { "sec-fetch-site": "same-origin", cookie };
}

async function send(port: number, input: {
  readonly method?: string;
  readonly path: string;
  readonly host: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1", port, method: input.method ?? "GET", path: input.path,
      headers: { host: input.host, ...input.headers }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0, headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.on("error", reject);
    request.end(input.body);
  });
}

async function openEventStream(instance: Instance): Promise<{
  readonly ended: Promise<void>;
  readonly waitFor: (needle: string) => Promise<void>;
}> {
  let request!: ClientRequest;
  let body = "";
  let wake = (): void => undefined;
  let nextChange = new Promise<void>((resolve) => { wake = resolve; });
  const opened = new Promise<void>((resolve, reject) => {
    request = httpRequest({
      host: "127.0.0.1", port: Number(instance.accessUrl.port), path: "/api/v1/events",
      headers: { host: instance.accessUrl.host, ...readHeaders(instance.cookie) }
    }, (response) => {
      resolve();
      response.on("data", (chunk) => {
        body += Buffer.from(chunk).toString("utf8");
        wake();
        nextChange = new Promise<void>((nextResolve) => { wake = nextResolve; });
      });
      response.once("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
  const ended = new Promise<void>((resolve) => request.once("close", resolve));
  await opened;
  return {
    ended,
    waitFor: async (needle) => {
      const deadline = Date.now() + 2_000;
      while (!body.includes(needle)) {
        if (Date.now() >= deadline) throw new Error(`等待 SSE 超时：${needle}`);
        await Promise.race([nextChange, new Promise((resolve) => setTimeout(resolve, 20))]);
      }
    }
  };
}
