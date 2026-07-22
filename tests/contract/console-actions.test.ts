import { EventEmitter } from "node:events";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalCoordinator, type ApprovalClock } from "../../src/approval/approval-coordinator.js";
import { ApprovalService } from "../../src/approval/approval-service.js";
import { CommandApplicationService } from "../../src/application/command-application-service.js";
import { ProfileApplicationService } from "../../src/application/profile-application-service.js";
import { buildCommand } from "../../src/commands/command-builder.js";
import { CommandRunner } from "../../src/commands/command-runner.js";
import type { HostConfig, LowRiskProfile } from "../../src/config/schema.js";
import { ConsoleActionRoutes } from "../../src/console/action-routes.js";
import { ConsoleAuthGuard } from "../../src/console/console-auth-guard.js";
import { ConsoleServer } from "../../src/console/console-server.js";
import type { StaticAssetProvider } from "../../src/console/static-assets.js";
import { HostRegistry } from "../../src/hosts/host-registry.js";
import { OperationManager, type MonotonicClock } from "../../src/operations/operation-manager.js";
import { PolicyEngine } from "../../src/policy/policy-engine.js";
import type { ApprovalRoute } from "../../src/approval/approval-coordinator.js";
import { testWithIds } from "../test-with-ids.js";

const assets: StaticAssetProvider = Object.freeze({
  paths: Object.freeze(["/"]),
  read: (path) => path === "/" ? { path, body: Buffer.from("<!doctype html>") } : undefined
});

class Clock implements MonotonicClock, ApprovalClock {
  public nowMs = 1_000;
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

class Channel extends EventEmitter {
  public readonly stderr = new EventEmitter();
  public signal(): void {}
  public close(): void { this.emit("close", 0, undefined); }
}

interface Fixture {
  readonly server: ConsoleServer;
  readonly port: number;
  readonly host: string;
  readonly origin: string;
  readonly cookie: string;
  readonly clock: Clock;
  readonly approvals: ApprovalCoordinator;
  readonly executed: Array<{ command: string; route: ApprovalRoute }>;
  readonly elicitationCalls: () => number;
}

describe("控制台命令与 Profile 动作", () => {
  const fixtures: Fixture[] = [];
  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) {
      fixture.approvals.shutdown();
      await fixture.server.close();
    }
  });

  testWithIds(["LC-SC-024", "LC-SC-025"],
    "命令预览逐字保留 Unicode 与 Shell 内容，摘要匹配后只执行一次", async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const command = "printf '中文'\n$HOME; echo \"原样\"";
    const preview = await post(fixture, "/api/v1/previews/command", { host: "linux", command });
    expect(preview.status).toBe(201);
    const body = JSON.parse(preview.body);
    expect(body).toMatchObject({
      intent: {
        kind: "raw_command", hosts: ["linux"], platformByHost: { linux: "linux" }, payload: { command }
      }
    });
    expect(body.impact).toContain("精确操作一次");
    expect(body.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(body.expiresAt).toBeGreaterThan(fixture.clock.nowMs);
    expect(fixture.approvals.get(body.approvalId)).toMatchObject({ route: "web_only", state: "pending" });
    expect(fixture.elicitationCalls()).toBe(0);
    expect(fixture.executed).toEqual([]);

    const mismatch = await post(fixture, `/api/v1/approvals/${body.approvalId}/decision`, {
      action: "accept", expectedDigest: "0".repeat(64)
    });
    expect(mismatch.status).toBe(409);
    expect(fixture.executed).toEqual([]);

    const accepted = await post(fixture, `/api/v1/approvals/${body.approvalId}/decision`, {
      action: "accept", expectedDigest: body.digest
    });
    expect(accepted.status).toBe(200);
    await tick();
    expect(fixture.executed).toEqual([{ command: buildCommand(linux, command), route: "web_only" }]);
    const duplicate = await post(fixture, `/api/v1/approvals/${body.approvalId}/decision`, {
      action: "accept", expectedDigest: body.digest
    });
    expect(duplicate.status).toBe(409);
    expect(fixture.executed).toHaveLength(1);
  });

  testWithIds(["LC-SC-023"], "严格拒绝额外字段、空命令、未知主机和不适用 Profile，且不会连接 SSH", async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const cases = [
      ["/api/v1/previews/command", { host: "linux", command: "true", extra: true }, 400],
      ["/api/v1/previews/command", { host: "linux", command: "" }, 400],
      ["/api/v1/previews/command", { host: "missing", command: "true" }, 404],
      ["/api/v1/previews/profile", { host: "linux", profileId: "missing", parameters: {} }, 404],
      ["/api/v1/previews/profile", { host: "windows", profileId: "linux-echo", parameters: { value: "中文" } }, 400],
      ["/api/v1/previews/profile", { host: "linux", profileId: "linux-echo", parameters: {}, extra: 1 }, 400]
    ] as const;
    for (const [path, body, status] of cases) {
      expect((await post(fixture, path, body)).status).toBe(status);
    }
    expect(fixture.executed).toEqual([]);

    const missingHeader = await send(fixture.port, {
      method: "POST", path: "/api/v1/previews/command", host: fixture.host,
      headers: {
        origin: fixture.origin, "sec-fetch-site": "same-origin", "content-type": "application/json",
        cookie: fixture.cookie
      }, body: JSON.stringify({ host: "linux", command: "true" })
    });
    expect(missingHeader.status).toBe(403);
  });

  it("Linux 与 Windows Profile 的实际编译命令和预览完全一致", async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    for (const input of [
      { host: "linux", profileId: "linux-echo", parameters: { value: "中文' $HOME;" } },
      { host: "windows", profileId: "windows-echo", parameters: { value: "中文' $HOME;" } }
    ]) {
      const preview = await post(fixture, "/api/v1/previews/profile", input);
      expect(preview.status).toBe(201);
      const body = JSON.parse(preview.body);
      const compiled = body.intent.payload.command as string;
      expect(compiled).toContain("中文");
      expect(body.intent.payload.parameters).toEqual(input.parameters);
      const accepted = await post(fixture, `/api/v1/approvals/${body.approvalId}/decision`, {
        action: "accept", expectedDigest: body.digest
      });
      expect(accepted.status).toBe(200);
      await tick();
      const target = input.host === "linux" ? linux : windows;
      expect(fixture.executed.at(-1)).toEqual({ command: buildCommand(target, compiled), route: "web_only" });
    }
    expect(fixture.elicitationCalls()).toBe(0);
  });

  testWithIds(["LC-SC-022"], "取消和超时都释放冻结预览且副作用为零", async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const cancelled = JSON.parse((await post(fixture, "/api/v1/previews/command", {
      host: "linux", command: "echo cancel"
    })).body);
    expect((await post(fixture, `/api/v1/approvals/${cancelled.approvalId}/decision`, {
      action: "cancel", expectedDigest: cancelled.digest
    })).status).toBe(200);
    expect(fixture.approvals.get(cancelled.approvalId)?.state).toBe("cancelled");

    const timed = JSON.parse((await post(fixture, "/api/v1/previews/command", {
      host: "linux", command: "echo timeout"
    })).body);
    fixture.clock.advance(101);
    expect(fixture.approvals.get(timed.approvalId)?.state).toBe("timed_out");
    expect((await post(fixture, `/api/v1/approvals/${timed.approvalId}/decision`, {
      action: "accept", expectedDigest: timed.digest
    })).status).toBe(409);
    expect(fixture.executed).toEqual([]);
  });

  testWithIds(["LC-SC-047"], "审批资源达到固定上限时返回 429 且不连接 SSH", async () => {
    const fixture = await startFixture(1);
    fixtures.push(fixture);
    expect((await post(fixture, "/api/v1/previews/command", {
      host: "linux", command: "echo first"
    })).status).toBe(201);
    const limited = await post(fixture, "/api/v1/previews/command", {
      host: "linux", command: "echo second"
    });
    expect(limited.status).toBe(429);
    expect(JSON.parse(limited.body)).toMatchObject({ error: { code: "RESOURCE_LIMIT", sideEffects: "none" } });
    expect(fixture.executed).toEqual([]);
  });
});

async function startFixture(maxRecords = 64): Promise<Fixture> {
  const clock = new Clock();
  const registry = new HostRegistry([linux, windows]);
  let operationId = 0;
  let approvalId = 0;
  let elicitationCalls = 0;
  const operations = new OperationManager({ clock, idFactory: () => `operation-${++operationId}` });
  const approvals = new ApprovalCoordinator({
    client: {
      supportsFormElicitation: () => true,
      elicit: async () => { elicitationCalls += 1; return { action: "accept" }; }
    },
    clock, approvalTimeoutMs: 100, maxRecords, idFactory: () => `approval-${++approvalId}`
  });
  const approval = new ApprovalService({
    supportsFormElicitation: () => true,
    elicit: async () => { elicitationCalls += 1; return { action: "accept" }; }
  }, clock, 100, operations, undefined, approvals);
  const executed: Array<{ command: string; route: ApprovalRoute }> = [];
  const runner = new CommandRunner({
    connect: async (_host, _timeout, route) => ({
      exec: (command, callback) => {
        executed.push({ command, route: route ?? "dual" });
        callback(undefined, new Channel() as never);
      },
      close: () => undefined
    })
  }, operations);
  const commands = new CommandApplicationService(registry, approval, runner);
  const profiles = new ProfileApplicationService(registry, new PolicyEngine(profileDefinitions), runner, approval);
  const actionRoutes = new ConsoleActionRoutes(commands, profiles, approvals);
  const server = new ConsoleServer({
    assets, actionRoutes,
    auth: new ConsoleAuthGuard({
      credentialFactory: () => ({ instanceId: "instancealpha1234", accessToken: "a".repeat(43) }),
      sessionTokenFactory: () => "b".repeat(43)
    })
  });
  const info = await server.start();
  const host = `instancealpha1234.localhost:${info.port}`;
  const origin = `http://${host}`;
  const exchange = await send(info.port, {
    method: "POST", path: "/api/v1/session", host,
    headers: {
      origin, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-ssh-mcp-request": "1"
    }, body: JSON.stringify({ accessToken: "a".repeat(43) })
  });
  return {
    server, port: info.port, host, origin,
    cookie: String(exchange.headers["set-cookie"]?.[0]).split(";")[0]!,
    clock, approvals, executed, elicitationCalls: () => elicitationCalls
  };
}

async function post(fixture: Fixture, path: string, body: unknown) {
  return await send(fixture.port, {
    method: "POST", path, host: fixture.host,
    headers: {
      origin: fixture.origin, "sec-fetch-site": "same-origin", "content-type": "application/json",
      "x-ssh-mcp-request": "1", cookie: fixture.cookie
    }, body: JSON.stringify(body)
  });
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

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const linux: HostConfig = {
  alias: "linux", environment: "test", platform: "linux", host: "linux.internal", port: 22,
  username: "tester", auth: { type: "pageant" }, shell: { type: "posix", command: "/bin/sh" },
  remoteRoots: ["/srv"]
};

const windows: HostConfig = {
  alias: "windows", environment: "test", platform: "windows", host: "windows.internal", port: 22,
  username: "tester", auth: { type: "pageant" }, shell: { type: "powershell", command: "powershell.exe" },
  remoteRoots: ["C:\\srv"]
};

const profileDefinitions: readonly LowRiskProfile[] = [
  {
    id: "linux-echo", hostAliases: ["linux"], platform: "linux", executable: "/usr/bin/printf", fixedArgs: [],
    parameters: [{ type: "enum", name: "value", required: true, values: ["中文", "中文' $HOME;"] }]
  },
  {
    id: "windows-echo", hostAliases: ["windows"], platform: "windows", commandType: "native",
    executable: "Write-Output.exe", fixedArgs: [],
    parameters: [{ type: "enum", name: "value", required: true, values: ["中文", "中文' $HOME;"] }]
  }
];
