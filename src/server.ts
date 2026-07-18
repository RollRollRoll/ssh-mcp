import { isAbsolute } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigLoader } from "./config/loader.js";
import { HostRegistry } from "./hosts/host-registry.js";
import { OperationManager } from "./operations/operation-manager.js";
import { registerHostsListTool } from "./tools/hosts-list.js";
import { registerOperationControlTools } from "./tools/operation-control.js";

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

export function createServer(registry?: HostRegistry, operationManager?: OperationManager): McpServer {
  const server = new McpServer({
    name: "ssh-mcp",
    version: "0.1.0"
  });

  registerTools(server, registry, operationManager);
  return server;
}

export async function startServer(configPath = resolveConfigPath()): Promise<void> {
  if (configPath === undefined) {
    throw new Error("启动服务需要 --config <absolute-path> 或 SSH_MCP_CONFIG");
  }
  const config = new ConfigLoader(configPath).load();
  const server = createServer(new HostRegistry(config.hosts), new OperationManager({
    limits: config.limits,
    outputBufferBytes: config.limits.outputBufferBytes
  }));

  await server.connect(new StdioServerTransport());
}

export function registerTools(server: McpServer, registry?: HostRegistry, operationManager?: OperationManager): void {
  // 使用高层 API 初始化工具 handler；移除后仍保留 T1 所需的空工具列表。
  const bootstrapRegistration = server.registerTool(
    "bootstrap-tool-registry",
    { description: "初始化工具注册表" },
    () => ({ content: [] })
  );

  bootstrapRegistration.remove();

  if (registry !== undefined) {
    registerHostsListTool(server, registry);
  }
  if (operationManager !== undefined) {
    registerOperationControlTools(server, operationManager);
  }
}
