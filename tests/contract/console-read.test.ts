import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalCoordinator } from "../../src/approval/approval-coordinator.js";
import type { HostConfig } from "../../src/config/schema.js";
import { ConsoleAuthGuard } from "../../src/console/console-auth-guard.js";
import { ConsoleReadRoutes } from "../../src/console/read-routes.js";
import { RuntimeRevisionHub } from "../../src/console/runtime-revision-hub.js";
import { RuntimeSnapshotProjector } from "../../src/console/runtime-snapshot-projector.js";
import { ConsoleServer } from "../../src/console/console-server.js";
import type { StaticAssetProvider } from "../../src/console/static-assets.js";
import { HostRegistry } from "../../src/hosts/host-registry.js";
import { OperationManager, type MonotonicClock } from "../../src/operations/operation-manager.js";
import { SessionManager } from "../../src/sessions/session-manager.js";
import { testWithIds } from "../test-with-ids.js";

const assets: StaticAssetProvider = Object.freeze({
  paths: Object.freeze(["/"]),
  read: (path) => path === "/" ? { path, body: Buffer.from("<!doctype html>") } : undefined
});

class Clock implements MonotonicClock {
  public nowMs = 0;
  private sequence = 0;
  private readonly timers = new Map<number, { due: number; callback: () => void }>();
  public now(): number { return this.nowMs; }
  public setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.sequence;
    this.timers.set(id, { due: this.nowMs + delayMs, callback });
    return id;
  }
  public clearTimeout(timer: unknown): void { this.timers.delete(timer as number); }
  public advance(ms: number): void {
    this.nowMs += ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.due <= this.nowMs);
      if (due.length === 0) return;
      for (const [id, timer] of due) { this.timers.delete(id); timer.callback(); }
    }
  }
}

interface Fixture {
  readonly server: ConsoleServer;
  readonly routes: ConsoleReadRoutes;
  readonly hub: RuntimeRevisionHub;
  readonly hosts: HostRegistry;
  readonly operations: OperationManager;
  readonly origin: string;
  readonly host: string;
  readonly port: number;
  readonly cookie: string;
}

describe("控制台只读接口", () => {
  const servers: ConsoleServer[] = [];
  afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); });

  testWithIds(["LC-SC-011", "LC-SC-012", "LC-SC-044"],
    "返回当前实例的安全权威快照，并强制同源会话", async () => {
    const fixture = await startFixture();
    servers.push(fixture.server);
    fixture.hosts.connectionOpened("alpha");
    const operation = fixture.operations.create({
      initialState: "running", source: "mcp", operationKind: "transfer", target: { hosts: ["alpha"] }
    });
    fixture.operations.updateResult(operation.operationId, {
      transferredBytes: 7, totalBytes: 10, source: "/不得暴露/本地", target: "/不得暴露/远端"
    });
    await Promise.resolve();

    const response = await send(fixture.port, {
      path: "/api/v1/snapshot", host: fixture.host,
      headers: apiHeaders(undefined, fixture.cookie)
    });
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(response.body)).toMatchObject({
      instanceId: "instancealpha1234", revision: 1, serviceState: "active",
      hosts: [{ alias: "alpha", connectionState: "connected" }],
      operations: [{ operationId: operation.operationId, progress: { transferredBytes: 7, totalBytes: 10 } }]
    });
    for (const secret of ["alpha.internal", "secret-user", "/private-key", "/不得暴露"]) {
      expect(response.body).not.toContain(secret);
    }
    expect((await send(fixture.port, {
      path: "/api/v1/snapshot", host: fixture.host,
      headers: { origin: fixture.origin, "sec-fetch-site": "same-origin" }
    })).status).toBe(401);
    expect((await send(fixture.port, {
      path: "/api/v1/snapshot", host: fixture.host,
      headers: apiHeaders("http://evil.example", fixture.cookie)
    })).status).toBe(403);
  });

  testWithIds(["LC-SC-015", "LC-SC-016", "LC-SC-017"],
    "按游标读取 stdout/stderr，报告截断，并区分无效、未知与过期操作", async () => {
    const clock = new Clock();
    const fixture = await startFixture(clock, 8);
    servers.push(fixture.server);
    const operation = fixture.operations.create({ initialState: "running" });
    fixture.operations.appendOutput(operation.operationId, "stdout", Buffer.from("123456"));
    fixture.operations.appendOutput(operation.operationId, "stderr", Buffer.from("<b>789</b>"));

    const first = await send(fixture.port, {
      path: `/api/v1/operations/${operation.operationId}/output?cursor=0&maxBytes=4`,
      host: fixture.host, headers: apiHeaders(fixture.origin, fixture.cookie)
    });
    expect(first.status).toBe(200);
    expect(JSON.parse(first.body)).toEqual({
      frames: [{ stream: "stderr", cursor: 8, encoding: "utf8", data: ">789" }],
      nextCursor: 12, minCursor: 8, truncated: true, droppedBytes: 8
    });
    expect(Object.keys(JSON.parse(first.body))).toEqual([
      "frames", "nextCursor", "minCursor", "truncated", "droppedBytes"
    ]);
    const invalidCursor = await send(fixture.port, {
      path: `/api/v1/operations/${operation.operationId}/output?cursor=nope`, host: fixture.host,
      headers: apiHeaders(fixture.origin, fixture.cookie)
    });
    expect(invalidCursor.status).toBe(400);
    expect(JSON.parse(invalidCursor.body)).toMatchObject({ error: { code: "INVALID_CURSOR" } });
    const invalidSize = await send(fixture.port, {
      path: `/api/v1/operations/${operation.operationId}/output?maxBytes=999999`, host: fixture.host,
      headers: apiHeaders(fixture.origin, fixture.cookie)
    });
    expect(invalidSize.status).toBe(400);
    expect(JSON.parse(invalidSize.body)).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    const missing = await send(fixture.port, {
      path: "/api/v1/operations/missing/output", host: fixture.host,
      headers: apiHeaders(fixture.origin, fixture.cookie)
    });
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body)).toMatchObject({ error: { code: "OPERATION_NOT_FOUND" } });

    fixture.operations.complete(operation.operationId);
    clock.advance(11);
    const expired = await send(fixture.port, {
      path: `/api/v1/operations/${operation.operationId}/output`, host: fixture.host,
      headers: apiHeaders(fixture.origin, fixture.cookie)
    });
    expect(expired.status).toBe(410);
    expect(JSON.parse(expired.body)).toMatchObject({ error: { code: "OPERATION_EXPIRED" } });
  });

  it("SSE 只发送修订失效信号，断开释放订阅，关闭时先发送 offline", async () => {
    const fixture = await startFixture();
    servers.push(fixture.server);
    const stream = await openEventStream(fixture);
    await stream.waitFor("event: ready");
    expect(stream.text()).toContain('data: {"revision":0}');
    expect(fixture.routes.activeEventStreamCount()).toBe(1);

    fixture.hosts.connectionOpened("alpha");
    fixture.operations.create({ initialState: "running" });
    await stream.waitFor("event: invalidated");
    expect(stream.text()).toContain('"revision":1');
    expect(stream.text()).toContain('"scopes":["hosts","operations"]');
    expect(stream.text()).not.toContain("secret-user");

    stream.abort();
    await waitUntil(() => fixture.routes.activeEventStreamCount() === 0);
    const shutdownStream = await openEventStream(fixture);
    await shutdownStream.waitFor("event: ready");
    const closed = fixture.server.close();
    await shutdownStream.waitFor("event: offline");
    await shutdownStream.ended;
    await closed;
    expect(fixture.routes.activeEventStreamCount()).toBe(0);
  });
});

async function startFixture(clock = new Clock(), outputBufferBytes = 64): Promise<Fixture> {
  let id = 0;
  const hub = new RuntimeRevisionHub();
  const hosts = new HostRegistry([hostConfig()]);
  const operations = new OperationManager({
    clock, outputBufferBytes, idFactory: () => `operation-${++id}`,
    limits: { resultRetentionMs: 10 }
  });
  const sessions = new SessionManager({ idFactory: () => "session-1" });
  const approvals = new ApprovalCoordinator({
    client: { supportsFormElicitation: () => false, elicit: async () => ({ action: "cancel" }) },
    clock
  });
  hosts.subscribe(() => hub.invalidate("hosts"));
  operations.subscribe(() => hub.invalidate("operations"));
  sessions.subscribe(() => hub.invalidate("sessions"));
  approvals.subscribe(() => hub.invalidate("approvals"));
  const projector = new RuntimeSnapshotProjector({
    instanceId: "instancealpha1234", revisions: hub, hosts, operations, sessions, approvals
  });
  const routes = new ConsoleReadRoutes(projector, hub, operations);
  const server = new ConsoleServer({
    assets,
    auth: new ConsoleAuthGuard({
      credentialFactory: () => ({ instanceId: "instancealpha1234", accessToken: "a".repeat(43) }),
      sessionTokenFactory: () => "b".repeat(43)
    }),
    readRoutes: routes
  });
  const info = await server.start();
  const host = `instancealpha1234.localhost:${info.port}`;
  const origin = `http://${host}`;
  const exchange = await send(info.port, {
    method: "POST", path: "/api/v1/session", host,
    headers: {
      origin, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-ssh-mcp-request": "1"
    },
    body: JSON.stringify({ accessToken: "a".repeat(43) })
  });
  const cookie = String(exchange.headers["set-cookie"]?.[0]).split(";")[0]!;
  return { server, routes, hub, hosts, operations, origin, host, port: info.port, cookie };
}

function hostConfig(): HostConfig {
  return {
    alias: "alpha", environment: "development", platform: "linux", host: "alpha.internal", port: 22,
    username: "secret-user", auth: { type: "privateKeyFile", path: "/private-key" },
    shell: { type: "posix", command: "/bin/sh" }, remoteRoots: ["/private-root"]
  };
}

function apiHeaders(origin: string | undefined, cookie: string): Record<string, string> {
  return { ...(origin === undefined ? {} : { origin }), "sec-fetch-site": "same-origin", cookie };
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

async function openEventStream(fixture: Fixture): Promise<{
  readonly abort: () => void;
  readonly ended: Promise<void>;
  readonly text: () => string;
  readonly waitFor: (needle: string) => Promise<void>;
}> {
  let request!: ClientRequest;
  let body = "";
  let wake = (): void => undefined;
  const changed = (): Promise<void> => new Promise((resolve) => { wake = resolve; });
  let nextChange = changed();
  const opened = new Promise<void>((resolve, reject) => {
    request = httpRequest({
      host: "127.0.0.1", port: fixture.port, path: "/api/v1/events",
      headers: { host: fixture.host, ...apiHeaders(fixture.origin, fixture.cookie) }
    }, (response) => {
      resolve();
      response.on("data", (chunk) => {
        body += Buffer.from(chunk).toString("utf8");
        wake();
        nextChange = changed();
      });
      response.once("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
  const ended = new Promise<void>((resolve) => request.once("close", resolve));
  await opened;
  return {
    abort: () => request.destroy(), ended, text: () => body,
    waitFor: async (needle) => {
      const timeoutAt = Date.now() + 2_000;
      while (!body.includes(needle)) {
        if (Date.now() >= timeoutAt) throw new Error(`等待 SSE 数据超时：${needle}`);
        await Promise.race([nextChange, new Promise((resolve) => setTimeout(resolve, 20))]);
      }
    }
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const timeoutAt = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= timeoutAt) throw new Error("等待条件超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
