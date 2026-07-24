import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, resolveConfigPath, resolveStartupConfig, startServer } from "../../src/server.js";
import { JsonLogger } from "../../src/observability/logger.js";
import type { ConsoleServerOptions } from "../../src/console/console-server.js";
import type { StaticAssetProvider } from "../../src/console/static-assets.js";
import { testWithIds } from "../test-with-ids.js";
import { StartupError, startupFailureContext } from "../../src/errors/startup-error.js";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const children: ReturnType<typeof spawn>[] = [];
const configPath = join(mkdtempSync(join(tmpdir(), "ssh-mcp-")), "config.yml");
const wiringConfigPath = join(mkdtempSync(join(tmpdir(), "ssh-mcp-wiring-")), "config.yml");

writeFileSync(configPath, `
version: 1
trustStore: /var/lib/ssh-mcp/trust.json
localRoots: [/workspace]
hosts:
  - alias: test-host
    environment: test
    platform: linux
    host: 192.0.2.10
    port: 22
    username: developer
    auth: { type: pageant }
    shell: { type: posix, command: /bin/sh }
    remoteRoots: [/srv/project]
`);
writeFileSync(wiringConfigPath, `
version: 1
trustStore: /var/lib/ssh-mcp/trust.json
localRoots: [/workspace]
limits:
  connectTimeoutMs: 1234
  approvalTimeoutMs: 25
  cancelConfirmationTimeoutMs: 20
hosts:
  - alias: test-host
    environment: test
    platform: linux
    host: 192.0.2.10
    port: 22
    username: developer
    auth: { type: pageant }
    shell: { type: posix, command: /bin/sh }
    remoteRoots: [/srv/project]
`);

afterEach(() => {
  for (const child of children) {
    child.kill();
  }
  children.length = 0;
});

describe("MCP stdio 启动入口", () => {
  it("只接受绝对配置路径，且启动参数优先于环境变量", () => {
    expect(resolveConfigPath(["--config", "/tmp/from-argument.yml"], {
      SSH_MCP_CONFIG: "/tmp/from-environment.yml"
    })).toBe("/tmp/from-argument.yml");
    expect(resolveConfigPath([], { SSH_MCP_CONFIG: "/tmp/from-environment.yml" }))
      .toBe("/tmp/from-environment.yml");
    expect(resolveStartupConfig([], {}, "/tmp/working-directory", "/home/tester")).toEqual({
      path: "/home/tester/.config/ssh-mcp/ssh-mcp.yml",
      source: "default"
    });
    expect(resolveConfigPath(
      ["--config", "~/.config/ssh-mcp/ssh-mcp.yml"], {}, "/tmp/working-directory", "/home/tester"
    )).toBe("/home/tester/.config/ssh-mcp/ssh-mcp.yml");
    expect(resolveConfigPath(
      [], { SSH_MCP_CONFIG: "~/.config/ssh-mcp/ssh-mcp.yml" }, "/tmp/working-directory", "/home/tester"
    )).toBe("/home/tester/.config/ssh-mcp/ssh-mcp.yml");
    expect(() => resolveConfigPath(["--config", "relative.yml"], {})).toThrow();
    expect(() => resolveConfigPath(["--host", "example.test"], {})).toThrow();
  });

  it("未指定配置时在全局目录生成模板并正常退出，第二次启动不覆盖模板", async () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), "ssh-mcp-bootstrap-default-"));
    const homeDirectory = mkdtempSync(join(tmpdir(), "ssh-mcp-bootstrap-home-"));
    const inheritedEnvironment = { ...process.env };
    delete inheritedEnvironment.SSH_MCP_CONFIG;
    inheritedEnvironment.HOME = homeDirectory;

    const first = spawn(process.execPath, [join(projectRoot, "dist/index.js")], {
      cwd: workingDirectory,
      env: inheritedEnvironment,
      stdio: ["ignore", "pipe", "pipe"]
    });
    children.push(first);
    const firstResult = await collectProcessResult(first);
    expect(firstResult.exitCode).toBe(0);

    const generatedPath = join(homeDirectory, ".config", "ssh-mcp", "ssh-mcp.yml");
    expect(existsSync(generatedPath)).toBe(true);
    expect(readFileSync(generatedPath, "utf8"))
      .toContain(`localRoots:\n  - ${JSON.stringify(realpathSync(workingDirectory))}`);
    expect(firstResult.stderr.split("\n").filter(Boolean).map((line) => JSON.parse(line)))
      .toContainEqual(expect.objectContaining({
        level: "info", event: "config.generated", state: "completed"
      }));

    const marker = "# 用户已编辑\n";
    writeFileSync(generatedPath, `${marker}${readFileSync(generatedPath, "utf8")}`);
    const second = spawn(process.execPath, [join(projectRoot, "dist/index.js")], {
      cwd: workingDirectory,
      env: inheritedEnvironment,
      stdio: ["ignore", "pipe", "pipe"]
    });
    children.push(second);
    await collectStderrEvents(second, "service.started");
    expect(readFileSync(generatedPath, "utf8")).toMatch(new RegExp(`^${marker}`));
  });

  testWithIds(["LC-AC-009"], "成功加载配置后完成初始化并注册基础工具，stdout 仅输出 MCP 帧", async () => {
    const child = spawn(process.execPath, ["dist/index.js"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        SSH_MCP_CONFIG: configPath
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    children.push(child);

    const responses = collectJsonLines(child, 2);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "contract-test", version: "1.0.0" }
      }
    })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {}
    })}\n`);
    const received = await responses;
    const initialize = received.find(isResponseFor(1));
    const toolsList = received.find(isResponseFor(2));

    expect(initialize).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: { listChanged: true } },
        instructions: expect.stringContaining("_sshMcp.console.accessUrl")
      }
    });
    expect(toolsList).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "hosts_list" }),
          expect.objectContaining({ name: "operation_get" }),
          expect.objectContaining({ name: "operation_cancel" }),
          expect.objectContaining({ name: "command_run" }),
          expect.objectContaining({ name: "profile_run" }),
          expect.objectContaining({ name: "session_open" }),
          expect.objectContaining({ name: "session_write" }),
          expect.objectContaining({ name: "session_read" }),
          expect.objectContaining({ name: "session_resize" }),
          expect.objectContaining({ name: "session_close" }),
          expect.objectContaining({ name: "file_upload" }),
          expect.objectContaining({ name: "file_download" })
        ])
      }
    });
    const commandRunTools = (toolsList as { result: { tools: Array<{ name: string }> } }).result.tools
      .filter((tool) => tool.name === "command_run");
    expect(commandRunTools).toHaveLength(1);
    const hostsListTool = (toolsList as {
      result: { tools: Array<{ name: string; outputSchema?: { properties?: Record<string, unknown> } }> }
    }).result.tools.find((tool) => tool.name === "hosts_list");
    expect(hostsListTool?.outputSchema?.properties).toHaveProperty("_sshMcp");
  });

  testWithIds(["LC-SC-051"],
    "首次工具调用拒绝启用或客户端不支持 Elicitation 时始终保持纯 stdio", async () => {
    let declinedAssetLoads = 0;
    const [declinedClientTransport, declinedServerTransport] = InMemoryTransport.createLinkedPair();
    const declinedRuntime = await startServer(wiringConfigPath, {
      transport: declinedServerTransport,
      adapter: { connect: async () => { throw new Error("未调用"); }, shutdown: () => undefined },
      consoleAssetsLoader: async () => { declinedAssetLoads += 1; return memoryAssets; },
      shutdownTimeoutMs: 20
    });
    const declinedClient = new Client({ name: "console-declined-test", version: "1" }, {
      capabilities: { elicitation: { form: {} } }
    });
    let prompts = 0;
    declinedClient.setRequestHandler(ElicitRequestSchema, async () => {
      prompts += 1;
      return { action: "decline" as const };
    });
    await declinedClient.connect(declinedClientTransport);
    await declinedClient.callTool({ name: "hosts_list", arguments: {} });
    await declinedClient.callTool({ name: "hosts_list", arguments: {} });
    expect(prompts).toBe(1);
    expect(declinedAssetLoads).toBe(0);
    await declinedClient.close();
    await declinedRuntime.shutdown();

    let unsupportedAssetLoads = 0;
    const [unsupportedClientTransport, unsupportedServerTransport] = InMemoryTransport.createLinkedPair();
    const unsupportedRuntime = await startServer(wiringConfigPath, {
      transport: unsupportedServerTransport,
      adapter: { connect: async () => { throw new Error("未调用"); }, shutdown: () => undefined },
      consoleAssetsLoader: async () => { unsupportedAssetLoads += 1; return memoryAssets; },
      shutdownTimeoutMs: 20
    });
    const unsupportedClient = new Client({ name: "console-unsupported-test", version: "1" });
    await unsupportedClient.connect(unsupportedClientTransport);
    await unsupportedClient.callTool({ name: "hosts_list", arguments: {} });
    await unsupportedClient.callTool({ name: "hosts_list", arguments: {} });
    expect(unsupportedAssetLoads).toBe(0);
    await unsupportedClient.close();
    await unsupportedRuntime.shutdown();
  });

  it("顶层启动失败只向 stderr 输出单行 JSON 稳定码，不泄露原始 Error、stack 或配置路径", async () => {
    const child = spawn(process.execPath, ["dist/index.js", "--config", "relative-secret.yml"], {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"]
    });
    children.push(child);
    const line = await collectOneStderrLine(child);
    expect(JSON.parse(line)).toMatchObject({
      level: "error", event: "service.stopped", state: "failed", errorCode: "INTERNAL_ERROR"
    });
    expect(line).not.toContain("relative-secret.yml");
    expect(line).not.toContain("Error:");
    expect(line).not.toContain("stack");
  });

  it("SIGTERM 触发有界幂等停止并输出 cleanup/service 停止事件", async () => {
    const child = spawn(process.execPath, ["dist/index.js"], {
      cwd: projectRoot,
      env: { ...process.env, SSH_MCP_CONFIG: configPath },
      stdio: ["pipe", "pipe", "pipe"]
    });
    children.push(child);
    const stopped = collectStderrEvents(child, "service.stopped");
    await collectStderrEvents(child, "service.started");
    const exited = new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("服务未在停止截止时间内退出")), 2_000);
      child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
    });
    child.kill("SIGTERM");
    const events = await stopped;
    await expect(exited).resolves.toBe(0);
    expect(events).toEqual(expect.arrayContaining(["cleanup.result", "service.stopped"]));
  });

  it("注册工具后可列出并调用", async () => {
    const server = createServer();
    server.registerTool("healthcheck", { description: "返回服务状态" }, () => ({
      content: [{ type: "text", text: "ok" }]
    }));

    const client = new Client({ name: "contract-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [expect.objectContaining({ name: "healthcheck" })]
      });
      await expect(client.callTool({ name: "healthcheck" })).resolves.toMatchObject({
        content: [{ type: "text", text: "ok" }]
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("startServer 将审批与连接预算贯穿真实端口，并装配安全事件及幂等有界 shutdown", async () => {
    const logLines: string[] = [];
    const connectTimeouts: number[] = [];
    let adapterShutdowns = 0;
    const channel = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter; signal: () => void; close: () => void;
      write: (_data: Buffer, callback?: (error?: Error | null) => void) => boolean;
      setWindow: () => void;
    };
    channel.stderr = new EventEmitter();
    channel.signal = () => undefined;
    channel.close = () => undefined;
    channel.write = (_data, callback) => { callback?.(); return true; };
    channel.setWindow = () => undefined;
    const adapter = {
      connect: async (_host: unknown, timeoutMs?: number) => {
        connectTimeouts.push(timeoutMs!);
        return {
          exec: (_command: string, callback: (error: Error | undefined, value: unknown) => void) => callback(undefined, channel),
          openShell: (_columns: number, _rows: number, _shell: string, callback: (error: Error | undefined, value: unknown) => void) => callback(undefined, channel),
          close: () => undefined,
          onClose: () => undefined
        };
      },
      shutdown: () => { adapterShutdowns += 1; }
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const runtime = await startServer(wiringConfigPath, {
      transport: serverTransport,
      adapter,
      logger: new JsonLogger({ write: (line) => logLines.push(line) }),
      shutdownTimeoutMs: 20
    });
    const client = new Client({ name: "wiring-test", version: "1" }, { capabilities: { elicitation: { form: {} } } });
    let approvals = 0;
    client.setRequestHandler(ElicitRequestSchema, async () => {
      approvals += 1;
      if (approvals <= 4) return { action: "accept" as const };
      return await new Promise<never>(() => undefined);
    });
    await client.connect(clientTransport);

    await expect(client.callTool({ name: "command_run", arguments: { hosts: ["test-host"], command: "echo safe" } }))
      .resolves.toMatchObject({ structuredContent: { state: "running" } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(client.callTool({ name: "session_open", arguments: { host: "test-host", columns: 80, rows: 24 } }))
      .resolves.toMatchObject({ structuredContent: { session: { state: "active" } } });
    await expect(client.callTool({ name: "file_upload", arguments: {
      hosts: ["test-host"], localSource: "/workspace/source", remoteTarget: "/srv/project/target",
      recursive: false, overwrite: false, executionMode: "parallel"
    } })).resolves.toMatchObject({ structuredContent: { state: "running" } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(connectTimeouts).toEqual([1234, 1234, 1234]);
    const startedAt = Date.now();
    await expect(client.callTool({ name: "command_run", arguments: { hosts: ["test-host"], command: "echo timeout" } }))
      .resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "APPROVAL_TIMEOUT" } } });
    expect(Date.now() - startedAt).toBeLessThan(1_000);

    await client.close();
    const firstShutdown = runtime.shutdown();
    expect(runtime.shutdown()).toBe(firstShutdown);
    await firstShutdown;
    expect(adapterShutdowns).toBe(1);
    const events = logLines.map((line) => JSON.parse(line) as { event: string }).map((record) => record.event);
    expect(events).toEqual(expect.arrayContaining([
      "config.loaded", "service.started", "operation.state_changed", "approval.result",
      "connection.state_changed", "cleanup.result", "service.stopped"
    ]));
    const ready = logLines.map((line) => JSON.parse(line) as { event: string; accessUrl?: string })
      .filter((record) => record.event === "console.ready");
    expect(ready).toHaveLength(1);
    expect(ready[0]?.accessUrl).toMatch(/^http:\/\/[a-z0-9]{16,64}\.localhost:\d+\/#access_token=[A-Za-z0-9_-]{43,128}$/);
    expect(logLines.join("\n")).not.toContain("echo safe");
    expect(logLines.join("\n")).not.toContain(wiringConfigPath);
  });

  testWithIds(["LC-SC-005"],
    "先启动 MCP stdio，首次工具调用获准后再启动控制台，运行期致命错误进入同一幂等关闭", async () => {
    const events: string[] = [];
    let consoleOptions: ConsoleServerOptions | undefined;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const originalStart = serverTransport.start.bind(serverTransport);
    serverTransport.start = async () => { events.push("mcp.start"); await originalStart(); };
    const runtime = await startServer(wiringConfigPath, {
      transport: serverTransport,
      adapter: {
        connect: async () => { throw new Error("未调用"); },
        shutdown: () => { events.push("adapter.close"); throw new Error("ssh close failed"); }
      },
      logger: new JsonLogger({ write: (line) => events.push(`log:${JSON.parse(line).event as string}`) }),
      consoleAssetsLoader: async () => { events.push("assets"); return memoryAssets; },
      consoleServerFactory: (options) => {
        consoleOptions = options;
        events.push("console.factory");
        return {
          start: async () => {
            events.push("console.start");
            const instanceId = options.auth!.instanceId;
            return {
              instanceId, port: 43210, origin: `http://${instanceId}.localhost:43210`,
              accessUrl: `http://${instanceId}.localhost:43210/#access_token=${"x".repeat(43)}`
            };
          },
          quiesce: () => events.push("console.quiesce"),
          close: async () => { events.push("console.close"); }
        };
      }
    });
    expect(events.indexOf("mcp.start")).toBeLessThan(events.indexOf("log:service.started"));
    expect(events).not.toContain("assets");
    const client = new Client({ name: "lazy-console-test", version: "1" }, {
      capabilities: { elicitation: { form: {} } }
    });
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept" as const }));
    await client.connect(clientTransport);
    const toolResult = await client.callTool({ name: "hosts_list", arguments: {} });
    expect(events.indexOf("log:service.started")).toBeLessThan(events.indexOf("assets"));
    expect(events.indexOf("assets")).toBeLessThan(events.indexOf("console.start"));
    expect(events.filter((event) => event === "log:console.ready")).toHaveLength(1);
    expect(toolResult.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining(`http://${consoleOptions!.auth!.instanceId}.localhost:43210/#access_token=${"x".repeat(43)}`)
    });
    expect(toolResult.structuredContent).toMatchObject({
      _sshMcp: {
        console: {
          state: "ready",
          accessUrl: `http://${consoleOptions!.auth!.instanceId}.localhost:43210/#access_token=${"x".repeat(43)}`
        }
      }
    });

    consoleOptions!.onFatalError?.(new Error("listener failed"));
    await runtime.shutdown();
    expect(events.filter((event) => event === "console.quiesce")).toHaveLength(1);
    expect(events.filter((event) => event === "adapter.close")).toHaveLength(1);
    expect(events.filter((event) => event === "console.close")).toHaveLength(1);
    await client.close();
  });

  it("URL elicitation 被拒绝时通过首次工具结果回退控制台地址", async () => {
    let consoleOptions: ConsoleServerOptions | undefined;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const runtime = await startServer(wiringConfigPath, {
      transport: serverTransport,
      adapter: { connect: async () => { throw new Error("未调用"); }, shutdown: () => undefined },
      consoleAssetsLoader: async () => memoryAssets,
      consoleServerFactory: (options) => {
        consoleOptions = options;
        return {
          start: async () => ({
            instanceId: options.auth!.instanceId,
            port: 43211,
            origin: `http://${options.auth!.instanceId}.localhost:43211`,
            accessUrl: `http://${options.auth!.instanceId}.localhost:43211/#access_token=${"y".repeat(43)}`
          }),
          quiesce: () => undefined,
          close: async () => undefined
        };
      }
    });
    const client = new Client({ name: "url-declined-test", version: "1" }, {
      capabilities: { elicitation: { form: {}, url: {} } }
    });
    client.setRequestHandler(ElicitRequestSchema, async (request) => ({
      action: request.params.mode === "form" ? "accept" as const : "decline" as const
    }));
    await client.connect(clientTransport);
    const toolResult = await client.callTool({ name: "hosts_list", arguments: {} });
    const expectedUrl = `http://${consoleOptions!.auth!.instanceId}.localhost:43211/#access_token=${"y".repeat(43)}`;
    expect(toolResult.content[0]).toMatchObject({ type: "text", text: expect.stringContaining(expectedUrl) });
    expect(toolResult.structuredContent).toMatchObject({
      _sshMcp: { console: { state: "ready", accessUrl: expectedUrl } }
    });
    await client.close();
    await runtime.shutdown();
  });

  testWithIds(["LC-SC-003"],
    "控制台失败不阻断 stdio 且返回真实错误码，MCP transport 失败仍回滚启动", async () => {
    let factoryCalls = 0;
    let adapterShutdowns = 0;
    const assetLogs: string[] = [];
    const [assetClientTransport, assetServerTransport] = InMemoryTransport.createLinkedPair();
    const assetRuntime = await startServer(wiringConfigPath, {
      transport: assetServerTransport,
      adapter: { connect: async () => { throw new Error("未调用"); }, shutdown: () => { adapterShutdowns += 1; } },
      logger: new JsonLogger({ write: (line) => assetLogs.push(line) }),
      consoleAssetsLoader: async () => { throw new Error("asset failed"); },
      consoleServerFactory: () => { factoryCalls += 1; throw new Error("不应调用"); },
      shutdownTimeoutMs: 20
    });
    const assetClient = new Client({ name: "asset-failure-test", version: "1" }, {
      capabilities: { elicitation: { form: {} } }
    });
    assetClient.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept" as const }));
    await assetClient.connect(assetClientTransport);
    const assetResult = await assetClient.callTool({ name: "hosts_list", arguments: {} });
    expect(JSON.stringify(assetResult.content)).toContain("CONSOLE_START_FAILED");
    expect(factoryCalls).toBe(0);
    expect(assetLogs.some((line) => line.includes("service.started"))).toBe(true);
    expect(assetLogs.some((line) => line.includes("console.start_failed"))).toBe(true);
    expect(assetLogs.some((line) => line.includes("console.ready"))).toBe(false);
    await assetClient.close();
    await assetRuntime.shutdown();
    expect(adapterShutdowns).toBe(1);

    const listenerEvents: string[] = [];
    const listenerLogs: string[] = [];
    const [listenerClientTransport, listenerServerTransport] = InMemoryTransport.createLinkedPair();
    const listenerRuntime = await startServer(wiringConfigPath, {
      transport: listenerServerTransport,
      adapter: {
        connect: async () => { throw new Error("未调用"); },
        shutdown: () => listenerEvents.push("adapter.close")
      },
      logger: new JsonLogger({ write: (line) => listenerLogs.push(line) }),
      consoleAssetsLoader: async () => memoryAssets,
      consoleServerFactory: () => ({
        start: async () => {
          listenerEvents.push("console.start");
          throw Object.assign(new Error("listener failed"), { code: "EPERM" });
        },
        quiesce: () => listenerEvents.push("console.quiesce"),
        close: async () => { listenerEvents.push("console.close"); }
      }),
      shutdownTimeoutMs: 20
    });
    const listenerClient = new Client({ name: "listener-failure-test", version: "1" }, {
      capabilities: { elicitation: { form: {} } }
    });
    listenerClient.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept" as const }));
    await listenerClient.connect(listenerClientTransport);
    const listenerResult = await listenerClient.callTool({ name: "hosts_list", arguments: {} });
    expect(JSON.stringify(listenerResult.content)).toContain("CONSOLE_LISTEN_DENIED");
    expect(JSON.stringify(listenerResult.content)).toContain("EPERM");
    expect(listenerEvents).toEqual(["console.start", "console.quiesce", "console.close"]);
    expect(listenerLogs.some((line) => line.includes("service.started"))).toBe(true);
    expect(listenerLogs.some((line) => line.includes("console.start_failed") && line.includes("EPERM"))).toBe(true);
    expect(listenerLogs.some((line) => line.includes("console.ready"))).toBe(false);
    await listenerClient.close();
    await listenerRuntime.shutdown();
    expect(listenerEvents).toContain("adapter.close");

    expect(startupFailureContext(new StartupError("CONSOLE_LISTEN_DENIED", "EPERM", new Error("secret"))))
      .toEqual({
        state: "failed",
        errorCode: "CONSOLE_LISTEN_DENIED",
        details: { systemErrorCode: "EPERM" }
      });

    const events: string[] = [];
    const transportLogs: string[] = [];
    await expect(startServer(wiringConfigPath, {
      transport: { start: async () => { throw new Error("mcp failed"); } } as never,
      adapter: { connect: async () => { throw new Error("未调用"); }, shutdown: () => events.push("adapter.close") },
      logger: new JsonLogger({ write: (line) => transportLogs.push(line) }),
      consoleAssetsLoader: async () => { events.push("assets"); return memoryAssets; },
      consoleServerFactory: () => { events.push("console.factory"); throw new Error("不应调用"); },
      shutdownTimeoutMs: 20
    })).rejects.toThrow("mcp failed");
    expect(events).toEqual(["adapter.close"]);
    expect(transportLogs.some((line) => line.includes("service.started") || line.includes("console.ready"))).toBe(false);
  });
});

const memoryAssets: StaticAssetProvider = Object.freeze({
  paths: Object.freeze(["/"]),
  read: (path) => path === "/" ? { path, body: Buffer.from("<!doctype html>") } : undefined
});

function collectJsonLines(child: ReturnType<typeof spawn>, count: number): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const messages: unknown[] = [];
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("未在超时时间内收到 MCP 响应")), 5_000);

    child.once("error", reject);
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines.filter(Boolean)) {
        messages.push(JSON.parse(line));
      }

      if (messages.length === count) {
        clearTimeout(timer);
        resolve(messages);
      }
    });
    let stderrBuffer = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
      const lines = stderrBuffer.split("\n");
      stderrBuffer = lines.pop() ?? "";
      try {
        for (const line of lines.filter(Boolean)) {
          const record = JSON.parse(line) as { level?: unknown; event?: unknown };
          if (typeof record.level !== "string" || typeof record.event !== "string") throw new Error("日志缺少安全字段");
        }
      } catch (error: unknown) {
        reject(error);
      }
    });
  });
}

function collectOneStderrLine(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("未收到 stderr JSON 日志")), 5_000);
    child.once("error", reject);
    child.stderr.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      resolve(buffer.slice(0, newline));
    });
  });
}

function collectProcessResult(child: ReturnType<typeof spawn>): Promise<{ readonly exitCode: number | null; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error("进程未在超时时间内退出")), 5_000);
    child.once("error", reject);
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stderr });
    });
  });
}

function collectStderrEvents(child: ReturnType<typeof spawn>, terminalEvent: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const events: string[] = [];
    const timer = setTimeout(() => reject(new Error(`未收到 ${terminalEvent} 日志`)), 5_000);
    child.once("error", reject);
    child.stderr.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      try {
        for (const line of lines.filter(Boolean)) {
          const event = (JSON.parse(line) as { event?: unknown }).event;
          if (typeof event !== "string") throw new Error("日志事件无效");
          events.push(event);
          if (event === terminalEvent) {
            clearTimeout(timer);
            resolve(events);
          }
        }
      } catch (error: unknown) {
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}

function isResponseFor(id: number) {
  return (message: unknown): message is { id: number } =>
    typeof message === "object" && message !== null && "id" in message && message.id === id;
}
