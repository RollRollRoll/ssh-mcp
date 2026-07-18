import { isAbsolute } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigLoader } from "./config/loader.js";
import { HostRegistry } from "./hosts/host-registry.js";
import { OperationManager } from "./operations/operation-manager.js";
import { ApprovalService, McpApprovalClient } from "./approval/approval-service.js";
import { CommandRunner } from "./commands/command-runner.js";
import { StrictHostKeyVerifier, type TrustConfirmation } from "./ssh/host-key.js";
import { SshAdapter } from "./ssh/ssh-adapter.js";
import { TrustStore } from "./ssh/trust-store.js";
import { registerCommandRunTool, type CommandRunDependencies } from "./tools/command-run.js";
import { registerHostsListTool } from "./tools/hosts-list.js";
import { registerOperationControlTools } from "./tools/operation-control.js";
import { registerProfileRunTool, type ProfileRunDependencies } from "./tools/profile-run.js";
import { PolicyEngine } from "./policy/policy-engine.js";
import { SessionManager } from "./sessions/session-manager.js";
import { registerSessionTools, type SessionToolDependencies } from "./tools/session-tools.js";

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

export function createServer(
  registry?: HostRegistry,
  operationManager?: OperationManager,
  commandRun?: CommandRunDependencies,
  profileRun?: ProfileRunDependencies,
  sessionTools?: SessionToolDependencies
): McpServer {
  const server = new McpServer({
    name: "ssh-mcp",
    version: "0.1.0"
  });

  registerTools(server, registry, operationManager, commandRun, profileRun, sessionTools);
  return server;
}

export async function startServer(configPath = resolveConfigPath()): Promise<void> {
  if (configPath === undefined) {
    throw new Error("启动服务需要 --config <absolute-path> 或 SSH_MCP_CONFIG");
  }
  const config = new ConfigLoader(configPath).load();
  const manager = new OperationManager({
    limits: config.limits,
    outputBufferBytes: config.limits.outputBufferBytes
  });
  const registry = new HostRegistry(config.hosts);
  const sessions = new SessionManager({
    outputBufferBytes: config.limits.outputBufferBytes,
    idleTimeoutMs: config.limits.sessionIdleTimeoutMs,
    closeConfirmationTimeoutMs: config.limits.cancelConfirmationTimeoutMs,
    retentionMs: config.limits.resultRetentionMs
  });
  const server = createServer(registry, manager);
  const approvalClient = new McpApprovalClient(server.server);
  const confirmation: TrustConfirmation = {
    supportsForm: () => approvalClient.supportsFormElicitation(),
    confirm: async (request, signal) => (await approvalClient.elicit({
      mode: "form",
      message: `确认登记主机 ${request.alias} 的密钥：${request.algorithm} ${request.fingerprint}`,
      requestedSchema: { type: "object", properties: {} },
      timeoutMs: 120_000
    }, signal)).action
  };
  // 命令和终端共享同一严格信任/认证适配器，但每次操作仍由适配器新建独立连接。
  const adapter = new SshAdapter(new StrictHostKeyVerifier(new TrustStore(config.trustStore), confirmation));
  const approval = new ApprovalService(approvalClient);
  const runner = new CommandRunner(adapter, manager);
  registerCommandRunTool(server, {
    registry,
    approval,
    runner
  });
  registerProfileRunTool(server, { registry, runner, policy: new PolicyEngine(config.lowRiskProfiles) });
  registerSessionTools(server, { registry, approval, sessions, adapter });

  await server.connect(new StdioServerTransport());
}

export function registerTools(
  server: McpServer,
  registry?: HostRegistry,
  operationManager?: OperationManager,
  commandRun?: CommandRunDependencies,
  profileRun?: ProfileRunDependencies,
  sessionTools?: SessionToolDependencies
): void {
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
  if (commandRun !== undefined) {
    registerCommandRunTool(server, commandRun);
  }
  if (profileRun !== undefined) {
    registerProfileRunTool(server, profileRun);
  }
  if (sessionTools !== undefined) {
    registerSessionTools(server, sessionTools);
  }
}
