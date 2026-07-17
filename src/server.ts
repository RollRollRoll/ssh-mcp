import { isAbsolute } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export function resolveConfigPath(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  if (args.length === 0) {
    return env.SSH_MCP_CONFIG;
  }

  if (args.length !== 2 || args[0] !== "--config") {
    throw new Error("启动入口仅支持 --config <absolute-path>");
  }

  if (!isAbsolute(args[1])) {
    throw new Error("--config 必须是绝对路径");
  }

  return args[1];
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "ssh-mcp",
    version: "0.1.0"
  });

  registerTools(server);
  return server;
}

export async function startServer(): Promise<void> {
  const server = createServer();

  await server.connect(new StdioServerTransport());
}

export function registerTools(server: McpServer): void {
  // 使用高层 API 初始化工具 handler；移除后仍保留 T1 所需的空工具列表。
  const bootstrapRegistration = server.registerTool(
    "bootstrap-tool-registry",
    { description: "初始化工具注册表" },
    () => ({ content: [] })
  );

  bootstrapRegistration.remove();
}
