import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, resolveConfigPath } from "../../src/server.js";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const children: ReturnType<typeof spawn>[] = [];
const configPath = join(mkdtempSync(join(tmpdir(), "ssh-mcp-")), "config.yml");

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
    expect(() => resolveConfigPath(["--config", "relative.yml"], {})).toThrow();
    expect(() => resolveConfigPath(["--host", "example.test"], {})).toThrow();
  });

  it("成功加载配置后完成初始化并注册基础工具，stdout 仅输出 MCP 帧", async () => {
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
        capabilities: { tools: { listChanged: true } }
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
          expect.objectContaining({ name: "session_close" })
        ])
      }
    });
    const commandRunTools = (toolsList as { result: { tools: Array<{ name: string }> } }).result.tools
      .filter((tool) => tool.name === "command_run");
    expect(commandRunTools).toHaveLength(1);
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
    child.stderr.on("data", (chunk: Buffer) => {
      reject(new Error(`服务向 stderr 输出错误：${chunk.toString()}`));
    });
  });
}

function isResponseFor(id: number) {
  return (message: unknown): message is { id: number } =>
    typeof message === "object" && message !== null && "id" in message && message.id === id;
}
