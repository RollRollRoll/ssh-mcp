import { EventEmitter } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { testWithIds } from "../test-with-ids.js";
import type { HostConfig, LowRiskProfile } from "../../src/config/schema.js";
import { buildCommand } from "../../src/commands/command-builder.js";
import { CommandRunner } from "../../src/commands/command-runner.js";
import type { OperationIntent } from "../../src/approval/operation-intent.js";
import { ErrorCodes } from "../../src/errors/error-codes.js";
import { HostRegistry } from "../../src/hosts/host-registry.js";
import { OperationManager } from "../../src/operations/operation-manager.js";
import { lexicalPathHandle } from "../../src/paths/path-guard.js";
import { PolicyEngine } from "../../src/policy/policy-engine.js";
import { createServer } from "../../src/server.js";
import { runPlatformProbe } from "../../src/ssh/platform-probe.js";

const linux: HostConfig = {
  alias: "linux", environment: "test", platform: "linux", host: "127.0.0.1", port: 22,
  username: "tester", auth: { type: "privateKeyFile", path: "/tmp/key" },
  shell: { type: "posix", command: "/bin/my shell'quoted" }, remoteRoots: ["/tmp"]
};
const windows: HostConfig = {
  ...linux, alias: "windows", platform: "windows", shell: { type: "powershell", command: "C:\\Program Files\\PowerShell\\pwsh.exe" }
};

describe("command_run 命令构造", () => {
  it("Linux 将登记 Shell 和完整原始命令各自按 POSIX 单参数字面量传给 -lc", () => {
    expect(buildCommand(linux, "printf '%s' \"$HOME\"; echo 中文")).toBe(
      "'/bin/my shell'\"'\"'quoted' -lc 'printf '\"'\"'%s'\"'\"' \"$HOME\"; echo 中文'"
    );
  });

  testWithIds(["SC-025", "MN-013"], "命令、路径和低风险规则均不跨平台翻译", async () => {
    const actual = buildCommand(windows, "Write-Output '中文'\r\n$env:Path");
    const encoded = actual.split(" ").at(-1);
    expect(actual).toBe('"C:\\Program Files\\PowerShell\\pwsh.exe" -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + encoded);
    expect(Buffer.from(encoded!, "base64").toString("utf16le")).toBe("Write-Output '中文'\r\n$env:Path");

    expect(() => lexicalPathHandle("C:\\Data\\input.txt", linux.remoteRoots, "posix"))
      .toThrow(expect.objectContaining({ code: ErrorCodes.PATH_DENIED }));

    const linuxOnlyProfile: LowRiskProfile = {
      id: "linux-only", hostAliases: ["windows"], platform: "linux", executable: "/usr/bin/du", fixedArgs: [], parameters: []
    };
    expect(new PolicyEngine([linuxOnlyProfile]).evaluate({ profileId: "linux-only", host: windows, parameters: {} }))
      .toMatchObject({ matched: false, error: { code: ErrorCodes.POLICY_REQUIRES_APPROVAL, sideEffects: "none" } });

    const mismatch = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
    mismatch.stderr = new EventEmitter();
    const probe = runPlatformProbe({
      exec: (_command, callback) => {
        callback(undefined, mismatch as never);
        setImmediate(() => {
          mismatch.emit("data", "SSH_MCP_PLATFORM=windows\nSSH_MCP_SHELL=powershell\nSSH_MCP_PS_MAJOR=7\n");
          mismatch.emit("close", 0, undefined);
        });
      }
    }, linux);
    await expect(probe).rejects.toMatchObject({ code: ErrorCodes.PLATFORM_MISMATCH });
  });
});

describe("command_run MCP 契约", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); });

  testWithIds(["SC-006", "SC-023", "MN-006"], "在任何审批、操作或连接前拒绝非法请求、通配符、动态组和超过10台", async () => {
    let approvals = 0;
    let connections = 0;
    const { client } = await connect({
      execute: async () => { approvals += 1; throw new Error("不应审批"); }
    }, () => { connections += 1; });

    await expect(client.callTool({ name: "command_run", arguments: { hosts: ["linux"], command: "  " } })).resolves.toMatchObject({ isError: true });
    await expect(client.callTool({ name: "command_run", arguments: { hosts: ["linux"], command: "echo ok", extra: true } })).resolves.toMatchObject({ isError: true });
    await expect(client.callTool({ name: "command_run", arguments: { hosts: ["missing"], command: "echo ok" } })).resolves.toMatchObject({
      isError: true, structuredContent: { error: { code: "HOST_NOT_REGISTERED", sideEffects: "none" } }
    });
    for (const hosts of [["*"], ["group:dynamic"], Array.from({ length: 11 }, (_value, index) => `host-${index}`)]) {
      await expect(client.callTool({ name: "command_run", arguments: { hosts, command: "echo never" } }))
        .resolves.toMatchObject({ isError: true });
    }
    expect(approvals).toBe(0);
    expect(connections).toBe(0);
  });

  it("审批的同一 Intent 才能启动后台操作，并立即返回 running", async () => {
    let connections = 0;
    let intentCommand = "";
    const { client } = await connect({
      execute: async (intent, sideEffect) => {
        intentCommand = intent.payload.command as string;
        return { approved: true as const, intent, value: await sideEffect(intent) };
      }
    }, () => { connections += 1; return new Promise(() => undefined); });

    await expect(client.callTool({ name: "command_run", arguments: { hosts: ["linux"], command: "echo 中文", executionMode: "sequential" } }))
      .resolves.toMatchObject({ structuredContent: { operationId: "command-1", state: "running" } });
    expect(intentCommand).toBe("echo 中文");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(connections).toBe(1);
  });

  it.each([
    ["拒绝", { code: "APPROVAL_DECLINED", finalState: "failed", details: undefined }],
    ["取消", { code: "APPROVAL_DECLINED", finalState: "failed", details: { reason: "cancelled" } }],
    ["超时", { code: "APPROVAL_TIMEOUT", finalState: "timed_out", details: { reason: "timeout" } }]
  ])("审批%s时，callTool 输出完整且严格的通用错误契约", async (_label, expected) => {
    let connections = 0;
    const { client } = await connect({
      execute: async () => ({
        approved: false as const,
        error: {
          code: expected.code,
          message: "安全错误消息",
          finalState: expected.finalState,
          retriable: false,
          sideEffects: "none" as const,
          ...(expected.details === undefined ? {} : { details: expected.details })
        }
      })
    }, () => { connections += 1; });

    await expect(client.callTool({ name: "command_run", arguments: { hosts: ["linux"], command: "echo never" } }))
      .resolves.toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: expected.code,
            finalState: expected.finalState,
            ...(expected.details === undefined ? {} : { details: expected.details })
          }
        }
      });
    expect(connections).toBe(0);
  });

  it("listTools 公布 command_run 的关联字段与安全 details 错误 Schema", async () => {
    const { client } = await connect({ execute: async () => { throw new Error("不应审批"); } }, () => undefined);
    const tools = await client.listTools();
    const commandRun = tools.tools.find((tool) => tool.name === "command_run");
    expect(commandRun?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        error: {
          type: "object",
          properties: {
            operationId: { type: "string" }, host: { type: "string" }, sessionId: { type: "string" }, details: { type: "object" }
          }
        }
      }
    });
  });

  async function connect(
    approval: { execute: <T>(intent: OperationIntent, sideEffect: (intent: OperationIntent) => T | Promise<T>) => Promise<unknown> },
    onConnect: () => unknown
  ): Promise<{ client: Client }> {
    const manager = new OperationManager({ idFactory: () => "command-1" });
    const runner = new CommandRunner({ connect: async () => {
      onConnect();
      return await new Promise<never>(() => undefined);
    } }, manager);
    const server = createServer(new HostRegistry([linux]), manager, { registry: new HostRegistry([linux]), approval: approval as never, runner });
    const client = new Client({ name: "contract-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closers.push(async () => { await client.close(); await server.close(); });
    return { client };
  }
});
