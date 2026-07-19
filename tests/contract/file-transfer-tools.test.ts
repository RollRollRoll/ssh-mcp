import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createOperationIntent, type OperationIntent } from "../../src/approval/operation-intent.js";
import type { HostConfig } from "../../src/config/schema.js";
import { HostRegistry } from "../../src/hosts/host-registry.js";
import { OperationManager } from "../../src/operations/operation-manager.js";
import { OperationManagerError } from "../../src/operations/operation-manager.js";
import { createMcpOperationError } from "../../src/errors/error-contract.js";
import { createServer } from "../../src/server.js";
import { ApprovalService } from "../../src/approval/approval-service.js";
import { TransferService } from "../../src/transfers/file-transfer.js";

const host: HostConfig = {
  alias: "linux", environment: "test", platform: "linux", host: "127.0.0.1", port: 22,
  username: "tester", auth: { type: "privateKeyFile", path: "/tmp/key" },
  shell: { type: "posix", command: "/bin/sh" }, remoteRoots: ["/remote"]
};

describe("file_upload/file_download MCP 契约", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); });

  it("严格工具面只公布两个单文件传输入口", async () => {
    const { client } = await connect({ execute: async () => { throw new Error("不应审批"); } }, () => undefined);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["file_upload", "file_download"]));
    expect(names).not.toEqual(expect.arrayContaining(["file_copy", "directory_upload", "file_resume"]));
  });

  it("未知主机、重复/多主机、越界路径、非法 recursive 和额外连接字段在审批及操作前整体拒绝", async () => {
    let approvals = 0;
    let starts = 0;
    const { client } = await connect({ execute: async () => { approvals += 1; throw new Error("不应审批"); } }, () => { starts += 1; });
    const base = { hosts: ["linux"], localSource: "/local/source", remoteTarget: "/remote/target", recursive: false, overwrite: false, executionMode: "parallel" };
    const requests = [
      { ...base, hosts: ["missing"] },
      { ...base, hosts: ["linux", "linux"] },
      { ...base, localSource: "/outside/source" },
      { ...base, remoteTarget: "/outside/target" },
      { ...base, recursive: "yes" },
      { ...base, password: "secret" }
    ];
    for (const request of requests) await expect(client.callTool({ name: "file_upload", arguments: request })).resolves.toMatchObject({ isError: true });
    expect(approvals).toBe(0);
    expect(starts).toBe(0);
  });

  it("recursive=true 只绑定审批并在获批后重建目录请求，审批前不启动传输", async () => {
    const intents: OperationIntent[] = [];
    let starts = 0;
    const { client } = await connect({
      execute: async <T>(intent: OperationIntent, sideEffect: (intent: OperationIntent) => T | Promise<T>) => {
        intents.push(intent);
        expect(starts).toBe(0);
        return { approved: true as const, intent, value: await sideEffect(intent) };
      }
    }, (actual) => {
      starts += 1;
      expect(actual).toMatchObject({ recursive: true });
      return { operationId: "directory-1", state: "running" };
    });
    await expect(client.callTool({ name: "file_upload", arguments: {
      hosts: ["linux"], localSource: "/local/tree", remoteTarget: "/remote/tree",
      recursive: true, overwrite: true, executionMode: "sequential"
    } })).resolves.toMatchObject({ structuredContent: { operationId: "directory-1", state: "running" } });
    expect(intents[0]?.payload).toMatchObject({ recursive: true, overwrite: true });
    expect(starts).toBe(1);
  });

  it("审批精确绑定方向、平台、有序主机、路径、覆盖、递归和执行模式，获批后立即返回 running", async () => {
    const intents: OperationIntent[] = [];
    const { client } = await connect({
      execute: async <T>(intent: OperationIntent, sideEffect: (intent: OperationIntent) => T | Promise<T>) => {
        intents.push(intent);
        return { approved: true as const, intent, value: await sideEffect(intent) };
      }
    }, () => ({ operationId: "transfer-1", state: "running" }));
    await expect(client.callTool({ name: "file_download", arguments: {
      hosts: ["linux"], remoteSource: "/remote/source.bin", localTarget: "/local/target.bin",
      recursive: false, overwrite: true, executionMode: "sequential"
    } })).resolves.toMatchObject({ structuredContent: { operationId: "transfer-1", state: "running" } });
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      kind: "download", hosts: ["linux"], platformByHost: { linux: "linux" }, executionMode: "sequential",
      payload: { remoteSource: "/remote/source.bin", localTarget: "/local/target.bin", recursive: false, overwrite: true }
    });
  });

  it("真实审批服务把传输工具的同一 Operation 从等待审批交给后台传输运行器", async () => {
    const registry = new HostRegistry([host]);
    const manager = new OperationManager({ idFactory: () => "transfer-approved" });
    const approval = new ApprovalService({
      supportsFormElicitation: () => true,
      elicit: async () => ({ action: "accept" })
    }, undefined, 5_000, manager);
    const transfer = new TransferService(manager, { prepare: async () => await new Promise<never>(() => undefined) });
    const server = createServer(registry, manager, undefined, undefined, undefined, {
      registry, approval, transfer, localRoots: ["/local"], localPlatform: "posix"
    });
    const client = new Client({ name: "contract", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    closers.push(async () => { await client.close(); await server.close(); });

    await expect(client.callTool({ name: "file_upload", arguments: {
      hosts: ["linux"], localSource: "/local/source", remoteTarget: "/remote/target",
      recursive: false, overwrite: false, executionMode: "parallel"
    } })).resolves.toMatchObject({ structuredContent: { operationId: "transfer-approved", state: "running" } });
    expect(manager.get("transfer-approved").state).toBe("running");
  });

  it("副作用请求完整地从 fresh approved Intent 重建并按获批 alias 重新解析登记主机", async () => {
    let actualRequest: unknown;
    const { client } = await connect({
      execute: async <T>(intent: OperationIntent, sideEffect: (intent: OperationIntent) => T | Promise<T>) => {
        const approved = createOperationIntent({
          kind: intent.kind,
          hosts: [...intent.hosts],
          platformByHost: { ...intent.platformByHost },
          payload: { ...intent.payload },
          ...(intent.executionMode === undefined ? {} : { executionMode: intent.executionMode })
        });
        return { approved: true as const, intent: approved, value: await sideEffect(approved) };
      }
    }, (request) => { actualRequest = request; return { operationId: "approved-only", state: "running" }; });
    await client.callTool({ name: "file_upload", arguments: {
      hosts: ["linux"], localSource: "/local/source.bin", remoteTarget: "/remote/target.bin",
      recursive: false, overwrite: true, executionMode: "sequential"
    } });
    expect(actualRequest).toEqual({
      direction: "upload",
      host,
      source: "/local/source.bin",
      target: "/remote/target.bin",
      overwrite: true,
      recursive: false
    });
    expect((actualRequest as { host: HostConfig }).host).not.toBe(host);
  });

  it("已批准 Intent 任一字段错配都返回 APPROVAL_INTENT_MISMATCH 且零副作用", async () => {
    let starts = 0;
    const { client } = await connect({
      execute: async <T>(_intent: OperationIntent, sideEffect: (intent: OperationIntent) => T | Promise<T>) => {
        const changed = createOperationIntent({
          kind: "upload", hosts: ["linux"], platformByHost: { linux: "linux" }, executionMode: "parallel",
          payload: { localSource: "/local/other", remoteTarget: "/remote/target", recursive: false, overwrite: false }
        });
        return { approved: true as const, intent: changed, value: await sideEffect(changed) };
      }
    }, () => { starts += 1; return { operationId: "never", state: "running" }; });
    await expect(client.callTool({ name: "file_upload", arguments: {
      hosts: ["linux"], localSource: "/local/source", remoteTarget: "/remote/target",
      recursive: false, overwrite: false, executionMode: "parallel"
    } })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "APPROVAL_INTENT_MISMATCH", sideEffects: "none" } } });
    expect(starts).toBe(0);
  });

  it("操作资源限制等已知启动错误映射为严格结构化 MCP 错误", async () => {
    const { client } = await connect({
      execute: async <T>(intent: OperationIntent, sideEffect: (intent: OperationIntent) => T | Promise<T>) =>
        ({ approved: true as const, intent, value: await sideEffect(intent) })
    }, () => { throw new OperationManagerError(createMcpOperationError({
      code: "RESOURCE_LIMIT", message: "x", finalState: "failed", retriable: false, sideEffects: "none"
    })); });
    await expect(client.callTool({ name: "file_upload", arguments: {
      hosts: ["linux"], localSource: "/local/source", remoteTarget: "/remote/target",
      recursive: false, overwrite: false, executionMode: "parallel"
    } })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "RESOURCE_LIMIT", sideEffects: "none" } } });
  });

  async function connect(
    approval: { execute: <T>(intent: OperationIntent, sideEffect: (intent: OperationIntent) => T | Promise<T>) => Promise<unknown> },
    start: (...args: unknown[]) => unknown
  ): Promise<{ client: Client }> {
    const registry = new HostRegistry([host]);
    const manager = new OperationManager();
    const server = createServer(registry, manager, undefined, undefined, undefined, {
      registry, approval: approval as never,
      transfer: { start: start as never },
      localRoots: ["/local"], localPlatform: "posix"
    });
    const client = new Client({ name: "contract", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    closers.push(async () => { await client.close(); await server.close(); });
    return { client };
  }
});
