import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ConfigLoader } from "./config/loader.js";
import { HostRegistry } from "./hosts/host-registry.js";
import { OperationManager } from "./operations/operation-manager.js";
import { ApprovalService, McpApprovalClient } from "./approval/approval-service.js";
import { CoordinatedTrustConfirmation } from "./approval/coordinated-trust-confirmation.js";
import { CommandRunner } from "./commands/command-runner.js";
import { StrictHostKeyVerifier } from "./ssh/host-key.js";
import { SshAdapter } from "./ssh/ssh-adapter.js";
import { ConnectionTrackingSshAdapter } from "./ssh/connection-tracking-adapter.js";
import { TrustStore } from "./ssh/trust-store.js";
import { registerCommandRunTool, type CommandRunDependencies } from "./tools/command-run.js";
import { registerHostsListTool } from "./tools/hosts-list.js";
import { registerOperationControlTools } from "./tools/operation-control.js";
import { registerProfileRunTool, type ProfileRunDependencies } from "./tools/profile-run.js";
import { PolicyEngine } from "./policy/policy-engine.js";
import { ProfileRemotePathVerifier } from "./policy/profile-remote-path-verifier.js";
import { SessionManager } from "./sessions/session-manager.js";
import { registerSessionTools, type SessionToolDependencies } from "./tools/session-tools.js";
import { registerFileTransferTools, type FileTransferToolDependencies } from "./tools/file-transfer-tools.js";
import { TransferService } from "./transfers/file-transfer.js";
import { SftpTransferBackend } from "./transfers/sftp-transfer-backend.js";
import { DirectoryTransferService } from "./transfers/directory-transfer.js";
import { SftpDirectoryTransferBackend } from "./transfers/directory-transfer-backend.js";
import { MultiHostCoordinator } from "./multihost/multi-host-coordinator.js";
import { JsonLogger, LogEvents } from "./observability/logger.js";
import { ErrorCodes } from "./errors/error-codes.js";
import { CommandApplicationService } from "./application/command-application-service.js";
import { ProfileApplicationService } from "./application/profile-application-service.js";
import { ConsoleAuthGuard } from "./console/console-auth-guard.js";
import {
  ConsoleServer,
  type ConsoleServerFactory,
  type ConsoleServerInfo,
  type ConsoleServerOptions,
  type ConsoleServerPort
} from "./console/console-server.js";
import { loadStaticAssets, type StaticAssetProvider } from "./console/static-assets.js";
import { RuntimeRevisionHub } from "./console/runtime-revision-hub.js";
import { RuntimeSnapshotProjector } from "./console/runtime-snapshot-projector.js";
import { ConsoleReadRoutes } from "./console/read-routes.js";
import { ConsoleActionRoutes } from "./console/action-routes.js";
import { OperationControlService } from "./console/operation-control-service.js";
import { DEFAULT_CONFIG_FILENAME } from "./config/default-config.js";
import { consoleStartupError, startupFailureContext, type StartupError } from "./errors/startup-error.js";
import { GatedMcpServer, type ToolCallNotice } from "./tools/gated-mcp-server.js";

export interface StartupConfigResolution {
  readonly path: string;
  readonly source: "argument" | "environment" | "default";
}

export function resolveStartupConfig(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  _workingDirectory: string = process.cwd(),
  homeDirectory: string = homedir()
): StartupConfigResolution {
  if (args.length === 0) {
    return env.SSH_MCP_CONFIG === undefined
      ? { path: join(homeDirectory, ".config", "ssh-mcp", DEFAULT_CONFIG_FILENAME), source: "default" }
      : { path: expandHomePath(env.SSH_MCP_CONFIG, homeDirectory), source: "environment" };
  }

  if (args.length !== 2 || args[0] !== "--config") {
    throw new Error("启动入口仅支持 --config <absolute-path>");
  }

  const configPath = expandHomePath(args[1], homeDirectory);
  if (!isAbsolute(configPath)) {
    throw new Error("--config 必须是绝对路径");
  }

  return { path: configPath, source: "argument" };
}

export function resolveConfigPath(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  workingDirectory: string = process.cwd(),
  homeDirectory: string = homedir()
): string {
  return resolveStartupConfig(args, env, workingDirectory, homeDirectory).path;
}

function expandHomePath(path: string, homeDirectory: string): string {
  return path.startsWith("~/") ? join(homeDirectory, path.slice(2)) : path;
}

export function createServer(
  registry?: HostRegistry,
  operationManager?: OperationManager,
  commandRun?: CommandRunDependencies,
  profileRun?: ProfileRunDependencies,
  sessionTools?: SessionToolDependencies,
  fileTransferTools?: FileTransferToolDependencies
): GatedMcpServer {
  const server = new GatedMcpServer({
    name: "ssh-mcp",
    version: "0.1.0"
  }, {
    instructions: "当工具结果包含 _sshMcp.console.accessUrl 时，必须把完整 URL 作为可点击链接提供给用户；该地址是当前本机控制台的一次性入口，不要改写为远端主机地址，也不要扫描远端 Web 端口。"
  });

  registerTools(server, registry, operationManager, commandRun, profileRun, sessionTools, fileTransferTools);
  return server;
}

export interface StartServerOptions {
  readonly transport?: Transport;
  readonly adapter?: Pick<SshAdapter, "connect"> & { shutdown?: () => void };
  readonly logger?: JsonLogger;
  readonly shutdownTimeoutMs?: number;
  readonly consoleServerFactory?: ConsoleServerFactory;
  readonly consoleAssetsLoader?: () => Promise<StaticAssetProvider>;
}

export interface ServerRuntime {
  readonly server: McpServer;
  readonly registry: HostRegistry;
  readonly operations: OperationManager;
  readonly sessions: SessionManager;
  shutdown(): Promise<void>;
}

export async function startServer(configPath = resolveConfigPath(), options: StartServerOptions = {}): Promise<ServerRuntime> {
  let config: ReturnType<ConfigLoader["load"]>;
  try {
    config = new ConfigLoader(configPath).load();
  } catch (error: unknown) {
    (options.logger ?? new JsonLogger()).error(LogEvents.CONFIG_LOADED, {
      state: "failed",
      errorCode: ErrorCodes.CONFIG_INVALID
    });
    throw error;
  }
  const knownOperationIds = new Set<string>();
  const knownSessionIds = new Set<string>();
  const knownHosts = new Set(config.hosts.map((host) => host.alias));
  const logger = options.logger ?? new JsonLogger(undefined, undefined, undefined, {
    allowedOperationIds: knownOperationIds,
    allowedSessionIds: knownSessionIds,
    allowedHosts: knownHosts
  });
  logger.info(LogEvents.CONFIG_LOADED, { state: "completed" });
  const manager = new OperationManager({
    limits: config.limits,
    outputBufferBytes: config.limits.outputBufferBytes,
    onStateChange: (snapshot) => {
      knownOperationIds.add(snapshot.operationId);
      logger.info(LogEvents.OPERATION_STATE_CHANGED, {
        operationId: snapshot.operationId,
        state: snapshot.state,
        errorCode: snapshot.error?.code
      });
    },
    onOutputTruncated: (event) => logger.warn(LogEvents.OUTPUT_TRUNCATED, {
      operationId: event.operationId,
      host: event.host,
      state: "running",
      details: { droppedBytes: event.droppedBytes, minCursor: event.minCursor }
    })
  });
  const registry = new HostRegistry(config.hosts);
  const sessions = new SessionManager({
    outputBufferBytes: config.limits.outputBufferBytes,
    idleTimeoutMs: config.limits.sessionIdleTimeoutMs,
    closeConfirmationTimeoutMs: config.limits.cancelConfirmationTimeoutMs,
    retentionMs: config.limits.resultRetentionMs,
    onStateChange: (snapshot) => {
      knownSessionIds.add(snapshot.sessionId);
      logger.info(LogEvents.OPERATION_STATE_CHANGED, {
        sessionId: snapshot.sessionId,
        host: snapshot.host,
        state: snapshot.state
      });
    }
  });
  const server = createServer(registry, manager);
  const approvalClient = new McpApprovalClient(server.server);
  const approval = new ApprovalService(approvalClient, undefined, config.limits.approvalTimeoutMs, manager, (event) => {
    if (event.operationId !== undefined) knownOperationIds.add(event.operationId);
    logger.info(LogEvents.APPROVAL_RESULT, {
      operationId: event.operationId,
      state: event.state,
      errorCode: event.errorCode,
      details: { digest: event.digest }
    });
  });
  const confirmation = new CoordinatedTrustConfirmation(approval.coordinator);
  // 命令和终端共享同一严格信任/认证适配器，但每次操作仍由适配器新建独立连接。
  const rawAdapter = options.adapter ?? new SshAdapter(new StrictHostKeyVerifier(
    new TrustStore(config.trustStore),
    confirmation,
    undefined,
    (host, errorCode) => logger.info(LogEvents.HOST_TRUST_RESULT, {
      host,
      state: errorCode === undefined ? "completed" : "failed",
      errorCode
    })
  ));
  const adapter = new ConnectionTrackingSshAdapter(rawAdapter, registry, config.limits.connectTimeoutMs, (host, state) => {
    logger.info(LogEvents.CONNECTION_STATE_CHANGED, { host, state });
  });
  const runner = new CommandRunner(adapter, manager, config.limits.connectTimeoutMs);
  const coordinator = new MultiHostCoordinator(manager);
  const policy = new PolicyEngine(config.lowRiskProfiles);
  const pathVerifier = new ProfileRemotePathVerifier();
  const commandApplication = new CommandApplicationService(registry, approval, runner, coordinator);
  const profileApplication = new ProfileApplicationService(
    registry, policy, runner, approval, coordinator, pathVerifier
  );
  registerCommandRunTool(server, {
    registry,
    approval,
    runner,
    coordinator,
    application: commandApplication
  });
  registerProfileRunTool(server, {
    registry,
    runner,
    coordinator,
    policy,
    pathVerifier,
    application: profileApplication
  });
  registerSessionTools(server, { registry, approval, sessions, adapter });
  const transferProgress = (event: {
    operationId: string; host: string; transferredBytes: number; totalBytes?: number;
    aggregateTransferredBytes?: number; completedItems: number; totalItems?: number;
  }): void => logger.info(LogEvents.TRANSFER_PROGRESS, {
    operationId: event.operationId,
    host: event.host,
    state: "running",
    details: {
      transferredBytes: event.transferredBytes,
      ...(event.aggregateTransferredBytes === undefined ? {} : {
        aggregateTransferredBytes: event.aggregateTransferredBytes
      }),
      ...(event.totalBytes === undefined ? {} : { totalBytes: event.totalBytes }),
      completedItems: event.completedItems,
      ...(event.totalItems === undefined ? {} : { totalItems: event.totalItems })
    }
  });
  const cleanupTimeoutMs = Math.max(1, Math.floor(config.limits.cancelConfirmationTimeoutMs / 2));
  const singleFileTransfer = new TransferService(manager,
    new SftpTransferBackend(adapter, config.localRoots, { cleanupTimeoutMs }), transferProgress);
  const directoryTransfer = new DirectoryTransferService(manager,
    new SftpDirectoryTransferBackend(adapter, config.localRoots, { cleanupTimeoutMs }), transferProgress);
  registerFileTransferTools(server, {
    registry,
    approval,
    transfer: { start: (request, operationId) => request.recursive ? directoryTransfer.start(request, operationId) : singleFileTransfer.start(request, operationId) },
    localRoots: config.localRoots,
    localPlatform: process.platform === "win32" ? "win32" : "posix",
    coordinator
  });

  const revisions = new RuntimeRevisionHub();
  registry.subscribe(() => revisions.invalidate("hosts"));
  manager.subscribe(() => revisions.invalidate("operations"));
  sessions.subscribe(() => revisions.invalidate("sessions"));
  approval.coordinator.subscribe(() => revisions.invalidate("approvals"));
  const consoleAuth = new ConsoleAuthGuard();
  const projector = new RuntimeSnapshotProjector({
    instanceId: consoleAuth.instanceId,
    revisions,
    hosts: registry,
    operations: manager,
    sessions,
    approvals: approval.coordinator,
    profiles: () => profileApplication.list()
  });
  const readRoutes = new ConsoleReadRoutes(projector, revisions, manager);
  const actionRoutes = new ConsoleActionRoutes(
    commandApplication,
    profileApplication,
    approval.coordinator,
    new OperationControlService(approval.coordinator, manager)
  );
  let runtime: ActiveServerRuntime | undefined;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? config.limits.cancelConfirmationTimeoutMs;
  const consoleLifecycle = new LazyConsoleLifecycle({
    server,
    logger,
    promptTimeoutMs: config.limits.approvalTimeoutMs,
    assetsLoader: options.consoleAssetsLoader ?? defaultConsoleAssetsLoader,
    serverFactory: options.consoleServerFactory ?? defaultConsoleServerFactory,
    serverOptions: {
      auth: consoleAuth,
      readRoutes,
      actionRoutes,
      onFatalError: () => { void runtime?.shutdown().catch(() => undefined); }
    }
  });
  server.setToolCallGate(() => consoleLifecycle.beforeFirstToolCall());
  try {
    server.server.onclose = () => {
      void runtime?.shutdown().catch(() => undefined);
    };
    await server.connect(options.transport ?? new StdioServerTransport());
    runtime = new ActiveServerRuntime(
      server, registry, manager, sessions, approval, adapter, logger, shutdownTimeoutMs,
      projector, revisions, consoleLifecycle
    );
    logger.info(LogEvents.SERVICE_STARTED, { state: "active" });
    return runtime;
  } catch (error: unknown) {
    await rollbackStartup(
      server, manager, sessions, approval, adapter, projector, revisions, consoleLifecycle, shutdownTimeoutMs
    );
    throw error;
  }
}

class ActiveServerRuntime implements ServerRuntime {
  private shutdownPromise: Promise<void> | undefined;

  public constructor(
    public readonly server: McpServer,
    public readonly registry: HostRegistry,
    public readonly operations: OperationManager,
    public readonly sessions: SessionManager,
    private readonly approval: ApprovalService,
    private readonly adapter: ConnectionTrackingSshAdapter,
    private readonly logger: JsonLogger,
    private readonly shutdownTimeoutMs: number,
    private readonly projector: RuntimeSnapshotProjector,
    private readonly revisions: RuntimeRevisionHub,
    private readonly consoleLifecycle: LazyConsoleLifecycle
  ) {}

  public shutdown(): Promise<void> {
    this.shutdownPromise ??= this.shutdownOnce();
    return this.shutdownPromise;
  }

  private async shutdownOnce(): Promise<void> {
    let cleanupFailed = false;
    cleanupFailed = !attemptCleanup(() => this.projector.setQuiescing()) || cleanupFailed;
    cleanupFailed = !attemptCleanup(() => this.consoleLifecycle.quiesce()) || cleanupFailed;
    cleanupFailed = !attemptCleanup(() => this.approval.shutdown()) || cleanupFailed;
    const operationResults = await Promise.allSettled([
      this.operations.shutdown(this.shutdownTimeoutMs),
      this.sessions.shutdown(this.shutdownTimeoutMs)
    ]);
    cleanupFailed = !attemptCleanup(() => this.adapter.shutdown()) || cleanupFailed;
    const mcpResults = await Promise.allSettled([bounded(this.server.close(), this.shutdownTimeoutMs)]);
    const consoleResults = await Promise.allSettled([bounded(this.consoleLifecycle.close(), this.shutdownTimeoutMs)]);
    cleanupFailed = !attemptCleanup(() => this.revisions.close()) || cleanupFailed;
    cleanupFailed = [...operationResults, ...mcpResults, ...consoleResults]
      .some((result) => result.status === "rejected") || cleanupFailed;
    this.logger.info(LogEvents.CLEANUP_RESULT, { state: cleanupFailed ? "unknown" : "completed" });
    this.logger.info(LogEvents.SERVICE_STOPPED, { state: cleanupFailed ? "unknown" : "closed" });
  }
}

interface LazyConsoleLifecycleOptions {
  readonly server: GatedMcpServer;
  readonly logger: JsonLogger;
  readonly promptTimeoutMs: number;
  readonly assetsLoader: () => Promise<StaticAssetProvider>;
  readonly serverFactory: ConsoleServerFactory;
  readonly serverOptions: Omit<ConsoleServerOptions, "assets">;
}

/** 默认不监听端口；只在首次工具调用得到用户同意后尝试启动控制台。 */
class LazyConsoleLifecycle {
  private activationPromise: Promise<ToolCallNotice | undefined> | undefined;
  private consoleServer: ConsoleServerPort | undefined;
  private readonly promptAbort = new AbortController();
  private noticeDelivered = false;
  private stopping = false;

  public constructor(private readonly options: LazyConsoleLifecycleOptions) {}

  public async beforeFirstToolCall(): Promise<ToolCallNotice | undefined> {
    this.activationPromise ??= this.promptAndActivate();
    const notice = await this.activationPromise;
    if (notice === undefined || this.noticeDelivered) return undefined;
    this.noticeDelivered = true;
    return notice;
  }

  public quiesce(): void {
    this.stopping = true;
    this.promptAbort.abort();
    this.consoleServer?.quiesce();
  }

  public async close(): Promise<void> {
    await this.activationPromise?.catch(() => undefined);
    await this.consoleServer?.close();
  }

  private async promptAndActivate(): Promise<ToolCallNotice | undefined> {
    if (this.stopping || this.options.server.server.getClientCapabilities()?.elicitation?.form === undefined) {
      return undefined;
    }
    let accepted = false;
    try {
      const response = await this.options.server.server.elicitInput({
        mode: "form",
        message: "是否启用本机 SSH MCP 网页控制台？启用后会尝试监听 127.0.0.1 的随机端口；客户端支持安全 URL 导航时会再提示你在浏览器中打开。如果运行环境禁止本地监听，SSH MCP 仍会继续通过 stdio 工作。",
        requestedSchema: { type: "object", properties: {} }
      }, {
        signal: this.promptAbort.signal,
        timeout: this.options.promptTimeoutMs,
        maxTotalTimeout: this.options.promptTimeoutMs
      });
      accepted = response.action === "accept";
    } catch {
      return undefined;
    }
    if (!accepted || this.stopping) return undefined;

    try {
      const assets = await this.options.assetsLoader();
      if (this.stopping) return undefined;
      const consoleServer = this.options.serverFactory({ ...this.options.serverOptions, assets });
      this.consoleServer = consoleServer;
      const info = await consoleServer.start();
      if (this.stopping) {
        consoleServer.quiesce();
        await consoleServer.close();
        return undefined;
      }
      this.options.logger.consoleReady(info.accessUrl);
      return await this.offerConsoleAccess(info) ? undefined : consoleReadyNotice(info);
    } catch (error: unknown) {
      const startupError = consoleStartupError(error);
      this.options.logger.error(LogEvents.CONSOLE_START_FAILED, startupFailureContext(startupError));
      try { this.consoleServer?.quiesce(); } catch { /* 失败实例不得阻断 stdio。 */ }
      await this.consoleServer?.close().catch(() => undefined);
      return consoleFailureNotice(startupError);
    }
  }

  private async offerConsoleAccess(info: ConsoleServerInfo): Promise<boolean> {
    if (this.stopping
      || this.options.server.server.getClientCapabilities()?.elicitation?.url === undefined) return false;
    try {
      await this.options.server.server.elicitInput({
        mode: "url",
        message: "SSH MCP 本机控制台已就绪。是否在本机浏览器中打开？该地址包含当前实例的一次性访问凭证，请勿分享或保存。",
        url: info.accessUrl,
        elicitationId: info.instanceId
      }, {
        signal: this.promptAbort.signal,
        timeout: this.options.promptTimeoutMs,
        maxTotalTimeout: this.options.promptTimeoutMs
      });
      return true;
    } catch {
      // 客户端拒绝、取消或无法呈现 URL 时，控制台和 stdio 仍保持可用。
      return false;
    }
  }
}

function consoleReadyNotice(info: ConsoleServerInfo): ToolCallNotice {
  return {
    type: "console_ready",
    message: "SSH MCP 本机控制台已就绪。请在本机可信浏览器中打开此一次性地址；不要分享或持久化。",
    accessUrl: info.accessUrl
  };
}

function consoleFailureNotice(error: StartupError): ToolCallNotice {
  const denied = error.errorCode === ErrorCodes.CONSOLE_LISTEN_DENIED;
  return {
    type: "warning",
    code: error.errorCode,
    message: denied
      ? "本机控制台未启动：运行环境拒绝监听 127.0.0.1。请调整 Codex 任务权限并重启 MCP；当前工具仍通过 stdio 正常执行。"
      : "本机控制台启动失败；当前工具仍通过 stdio 正常执行。",
    ...(error.systemErrorCode === undefined ? {} : {
      details: { systemErrorCode: error.systemErrorCode }
    })
  };
}

const defaultConsoleServerFactory: ConsoleServerFactory = (options) => new ConsoleServer(options);

async function defaultConsoleAssetsLoader(): Promise<StaticAssetProvider> {
  return await loadStaticAssets(fileURLToPath(new URL("../dist/console/", import.meta.url)));
}

async function rollbackStartup(
  server: McpServer,
  operations: OperationManager,
  sessions: SessionManager,
  approval: ApprovalService,
  adapter: ConnectionTrackingSshAdapter,
  projector: RuntimeSnapshotProjector,
  revisions: RuntimeRevisionHub,
  consoleLifecycle: LazyConsoleLifecycle,
  timeoutMs: number
): Promise<void> {
  attemptCleanup(() => projector.setQuiescing());
  attemptCleanup(() => consoleLifecycle.quiesce());
  attemptCleanup(() => approval.shutdown());
  await Promise.allSettled([operations.shutdown(timeoutMs), sessions.shutdown(timeoutMs)]);
  attemptCleanup(() => adapter.shutdown());
  await Promise.allSettled([bounded(server.close(), timeoutMs)]);
  await Promise.allSettled([bounded(consoleLifecycle.close(), timeoutMs)]);
  attemptCleanup(() => revisions.close());
}

function attemptCleanup(cleanup: () => void): boolean {
  try {
    cleanup();
    return true;
  } catch {
    return false;
  }
}

async function bounded(work: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("停止超时")), timeoutMs);
        timer.unref();
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function registerTools(
  server: McpServer,
  registry?: HostRegistry,
  operationManager?: OperationManager,
  commandRun?: CommandRunDependencies,
  profileRun?: ProfileRunDependencies,
  sessionTools?: SessionToolDependencies,
  fileTransferTools?: FileTransferToolDependencies
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
    registerCommandRunTool(server, {
      ...commandRun,
      ...(operationManager === undefined || commandRun.coordinator !== undefined ? {} : { coordinator: new MultiHostCoordinator(operationManager) })
    });
  }
  if (profileRun !== undefined) {
    registerProfileRunTool(server, {
      ...profileRun,
      ...(operationManager === undefined || profileRun.coordinator !== undefined ? {} : { coordinator: new MultiHostCoordinator(operationManager) })
    });
  }
  if (sessionTools !== undefined) {
    registerSessionTools(server, sessionTools);
  }
  if (fileTransferTools !== undefined) {
    registerFileTransferTools(server, {
      ...fileTransferTools,
      ...(operationManager === undefined || fileTransferTools.coordinator !== undefined ? {} : { coordinator: new MultiHostCoordinator(operationManager) })
    });
  }
}
