import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import type { OperationIntent } from "../../src/approval/operation-intent.js";
import type { HostConfig, LowRiskProfile } from "../../src/config/schema.js";
import { HostRegistry } from "../../src/hosts/host-registry.js";
import { OperationManager, type OperationSnapshot } from "../../src/operations/operation-manager.js";
import { PolicyEngine } from "../../src/policy/policy-engine.js";
import { createServer } from "../../src/server.js";

const registeredHosts = Array.from({ length: 10 }, (_value, index) => host(`host-${index + 1}`));
const closers: Array<() => Promise<void>> = [];

describe("Requirement 多主机协作", () => {
  afterEach(async () => { await Promise.all(closers.splice(0).map(async (close) => await close())); });

  it("2 台命令审批绑定完整有序集合；10 台可执行、11 台在任何启动前拒绝", async () => {
    const manager = new OperationManager();
    const registry = new HostRegistry(registeredHosts);
    const intents: OperationIntent[] = [];
    const started: string[] = [];
    const startsAtApproval: number[] = [];
    const runner = { start: completedStart(manager, started) };
    const { client } = await openServer(manager, registry, {
      commandRun: {
        registry,
        runner: runner as never,
        approval: { execute: async <T>(intent: OperationIntent, sideEffect: (approved: OperationIntent) => T | Promise<T>) => {
          intents.push(intent);
          startsAtApproval.push(started.length);
          return { approved: true as const, intent, value: await sideEffect(intent) };
        } }
      }
    });

    const first = await client.callTool({ name: "command_run", arguments: { hosts: ["host-2", "host-1"], command: "echo ok", executionMode: "parallel" } });
    await expect(terminal(manager, first.structuredContent?.operationId as string)).resolves.toMatchObject({ state: "completed" });
    expect(started).toEqual(["host-2", "host-1"]);
    expect(startsAtApproval).toEqual([0]);
    expect(intents[0]).toMatchObject({ hosts: ["host-2", "host-1"], platformByHost: { "host-1": "linux", "host-2": "linux" } });

    const ten = await client.callTool({ name: "command_run", arguments: { hosts: registeredHosts.map((item) => item.alias), command: "echo ten" } });
    await expect(terminal(manager, ten.structuredContent?.operationId as string)).resolves.toMatchObject({ state: "completed" });
    expect(started).toHaveLength(12);
    expect(startsAtApproval).toEqual([0, 2]);
    const beforeRejected = started.length;
    await expect(client.callTool({ name: "command_run", arguments: { hosts: [...registeredHosts.map((item) => item.alias), "host-11"], command: "echo never" } }))
      .resolves.toMatchObject({ isError: true });
    expect(started).toHaveLength(beforeRejected);
    expect(intents).toHaveLength(2);
  });

  it("Profile 对集合整体匹配后按顺序协调，不匹配时零启动", async () => {
    const manager = new OperationManager();
    const registry = new HostRegistry(registeredHosts.slice(0, 2));
    const started: string[] = [];
    const profile: LowRiskProfile = {
      id: "echo", hostAliases: ["host-1", "host-2"], platform: "linux", executable: "/bin/echo", fixedArgs: ["ok"], parameters: []
    };
    const { client } = await openServer(manager, registry, {
      profileRun: { registry, runner: { start: completedStart(manager, started) } as never, policy: new PolicyEngine([profile]) }
    });

    const response = await client.callTool({ name: "profile_run", arguments: { profileId: "echo", hosts: ["host-2", "host-1"], parameters: {}, executionMode: "sequential" } });
    await expect(terminal(manager, response.structuredContent?.operationId as string)).resolves.toMatchObject({ state: "completed" });
    expect(started).toEqual(["host-2", "host-1"]);

    await expect(client.callTool({ name: "profile_run", arguments: { profileId: "echo", hosts: ["host-1", "missing"], parameters: {} } }))
      .resolves.toMatchObject({ isError: true });
    expect(started).toEqual(["host-2", "host-1"]);
  });

  it("多主机下载给每个子操作分配 <localTarget>/<hostAlias>，不会互相覆盖", async () => {
    const manager = new OperationManager();
    const registry = new HostRegistry(registeredHosts.slice(0, 2));
    const requests: Array<{ host: HostConfig; target: string }> = [];
    const { client } = await openServer(manager, registry, {
      fileTransfer: {
        registry, localRoots: ["/local"], localPlatform: "posix",
        approval: { execute: async <T>(intent: OperationIntent, sideEffect: (approved: OperationIntent) => T | Promise<T>) =>
          ({ approved: true as const, intent, value: await sideEffect(intent) }) },
        transfer: { start: (request: { host: HostConfig; target: string }) => {
          requests.push({ host: request.host, target: request.target });
          const snapshot = manager.create({ initialState: "running", runner: { cancel: () => undefined }, timeoutKind: "transfer" });
          queueMicrotask(() => manager.complete(snapshot.operationId, { host: request.host.alias }));
          return snapshot;
        } }
      }
    });

    const response = await client.callTool({ name: "file_download", arguments: {
      hosts: ["host-1", "host-2"], remoteSource: "/remote/source.bin", localTarget: "/local/downloads",
      recursive: false, overwrite: false, executionMode: "parallel"
    } });
    await expect(terminal(manager, response.structuredContent?.operationId as string)).resolves.toMatchObject({ state: "completed" });
    expect(requests).toEqual([
      { host: registeredHosts[0], target: "/local/downloads/host-1" },
      { host: registeredHosts[1], target: "/local/downloads/host-2" }
    ]);
  });

  it("多主机下载在审批前拒绝不安全或平台等价冲突的 alias，且零启动", async () => {
    let operationCreations = 0;
    const manager = new OperationManager({ idFactory: () => `unexpected-${++operationCreations}` });
    const posixRegistry = new HostRegistry([host("."), host("a/b")]);
    let approvals = 0;
    let starts = 0;
    const approval = { execute: async <T>(intent: OperationIntent, sideEffect: (approved: OperationIntent) => T | Promise<T>) => {
      approvals += 1;
      return { approved: true as const, intent, value: await sideEffect(intent) };
    } };
    const posix = await openServer(manager, posixRegistry, {
      fileTransfer: {
        registry: posixRegistry, localRoots: ["/local"], localPlatform: "posix", approval,
        transfer: { start: () => { starts += 1; throw new Error("不应启动"); } }
      }
    });
    await expect(posix.client.callTool({ name: "file_download", arguments: {
      hosts: [".", "a/b"], remoteSource: "/remote/source.bin", localTarget: "/local/downloads",
      recursive: false, overwrite: false, executionMode: "parallel"
    } })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "PATH_DENIED" } } });
    expect(approvals).toBe(0);
    expect(starts).toBe(0);

    const portableRegistry = new HostRegistry([
      host("C:host"), host("CON"), host("NUL.txt"), host("bad\u0085alias"), host("COM¹"), host("LPT²"), host("okay")
    ]);
    const portable = await openServer(manager, portableRegistry, {
      fileTransfer: {
        registry: portableRegistry, localRoots: ["/local"], localPlatform: "posix", approval,
        transfer: { start: () => { starts += 1; throw new Error("不应启动"); } }
      }
    });
    for (const alias of ["C:host", "CON", "NUL.txt", "bad\u0085alias", "COM¹", "LPT²"]) {
      await expect(portable.client.callTool({ name: "file_download", arguments: {
        hosts: [alias, "okay"], remoteSource: "/remote/source.bin", localTarget: "/local/downloads",
        recursive: false, overwrite: false, executionMode: "parallel"
      } })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "PATH_DENIED" } } });
    }
    expect(approvals).toBe(0);
    expect(starts).toBe(0);

    const windowsRegistry = new HostRegistry([host("Host"), host("host"), host("Σ"), host("ς")]);
    const windows = await openServer(manager, windowsRegistry, {
      fileTransfer: {
        registry: windowsRegistry, localRoots: ["C:\\local"], localPlatform: "win32", approval,
        transfer: { start: () => { starts += 1; throw new Error("不应启动"); } }
      }
    });
    await expect(windows.client.callTool({ name: "file_download", arguments: {
      hosts: ["Host", "host"], remoteSource: "/remote/source.bin", localTarget: "C:\\local\\downloads",
      recursive: false, overwrite: false, executionMode: "parallel"
    } })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "PATH_DENIED" } } });
    expect(approvals).toBe(0);
    expect(starts).toBe(0);
    expect(operationCreations).toBe(0);

    await expect(windows.client.callTool({ name: "file_download", arguments: {
      hosts: ["Σ", "ς"], remoteSource: "/remote/source.bin", localTarget: "C:\\local\\downloads",
      recursive: false, overwrite: false, executionMode: "parallel"
    } })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "PATH_DENIED" } } });
    expect(approvals).toBe(0);
    expect(starts).toBe(0);
    expect(operationCreations).toBe(0);
  });

  it("POSIX 多主机下载允许平台专属标点 alias，并精确派生各自目标", async () => {
    const manager = new OperationManager();
    const registry = new HostRegistry([host("prod:blue"), host("build?fast")]);
    const requests: Array<{ host: string; target: string }> = [];
    const { client } = await openServer(manager, registry, {
      fileTransfer: {
        registry, localRoots: ["/local"], localPlatform: "posix",
        approval: { execute: async <T>(intent: OperationIntent, sideEffect: (approved: OperationIntent) => T | Promise<T>) =>
          ({ approved: true as const, intent, value: await sideEffect(intent) }) },
        transfer: { start: (request: { host: HostConfig; target: string }) => {
          requests.push({ host: request.host.alias, target: request.target });
          const snapshot = manager.create({ initialState: "running", runner: { cancel: () => undefined }, timeoutKind: "transfer" });
          queueMicrotask(() => manager.complete(snapshot.operationId, { host: request.host.alias }));
          return snapshot;
        } }
      }
    });

    const response = await client.callTool({ name: "file_download", arguments: {
      hosts: ["prod:blue", "build?fast"], remoteSource: "/remote/source.bin", localTarget: "/local/downloads",
      recursive: false, overwrite: false, executionMode: "parallel"
    } });
    await expect(terminal(manager, response.structuredContent?.operationId as string)).resolves.toMatchObject({ state: "completed" });
    expect(requests).toEqual([
      { host: "prod:blue", target: "/local/downloads/prod:blue" },
      { host: "build?fast", target: "/local/downloads/build?fast" }
    ]);
  });
});

async function openServer(
  manager: OperationManager,
  registry: HostRegistry,
  dependencies: {
    commandRun?: Parameters<typeof createServer>[2];
    profileRun?: Parameters<typeof createServer>[3];
    fileTransfer?: Parameters<typeof createServer>[5];
  }
): Promise<{ client: Client }> {
  const server = createServer(registry, manager, dependencies.commandRun, dependencies.profileRun, undefined, dependencies.fileTransfer);
  const client = new Client({ name: "acceptance", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  closers.push(async () => { await client.close(); await server.close(); });
  return { client };
}

function completedStart(manager: OperationManager, started: string[]) {
  return (target: HostConfig): OperationSnapshot => {
    started.push(target.alias);
    const snapshot = manager.create({ initialState: "running", runner: { cancel: () => undefined }, timeoutKind: "command" });
    queueMicrotask(() => manager.complete(snapshot.operationId, { host: target.alias }));
    return snapshot;
  };
}

async function terminal(manager: OperationManager, operationId: string) {
  for (let index = 0; index < 100; index += 1) {
    const snapshot = manager.get(operationId);
    if (!["awaiting_approval", "running"].includes(snapshot.state)) return snapshot;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("操作未在预期时间内结束");
}

function host(alias: string): HostConfig {
  return {
    alias, environment: "test", platform: "linux", host: "127.0.0.1", port: 22, username: "tester",
    auth: { type: "pageant" }, shell: { type: "posix", command: "/bin/sh" }, remoteRoots: ["/remote"]
  };
}
