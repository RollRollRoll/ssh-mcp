import type { HostConfig } from "../config/schema.js";
import { HostRegistry } from "../hosts/host-registry.js";
import type { SshAdapter, SshConnection } from "./ssh-adapter.js";
import type { ApprovalRoute } from "../approval/approval-coordinator.js";

/** 为所有命令、会话与传输共用的连接入口维护当前连接引用计数。 */
export class ConnectionTrackingSshAdapter {
  public constructor(
    private readonly adapter: Pick<SshAdapter, "connect">,
    private readonly registry: HostRegistry,
    private readonly connectTimeoutMs: number,
    private readonly onStateChange?: (host: string, state: "connected" | "disconnected") => void
  ) {}

  public async connect(
    host: HostConfig,
    _timeoutMs = this.connectTimeoutMs,
    approvalRoute: ApprovalRoute = "dual"
  ): Promise<SshConnection> {
    let connection: SshConnection;
    try {
      connection = await this.adapter.connect(host, this.connectTimeoutMs, approvalRoute);
    } catch (error: unknown) {
      const before = this.registry.connectionState(host.alias);
      this.registry.connectionFailed(host.alias);
      this.emitActualState(host.alias, before);
      throw error;
    }
    const beforeOpen = this.registry.connectionState(host.alias);
    this.registry.connectionOpened(host.alias);
    this.emitActualState(host.alias, beforeOpen);
    let closed = false;
    const markClosed = (): void => {
      if (closed) return;
      closed = true;
      const beforeClose = this.registry.connectionState(host.alias);
      this.registry.connectionClosed(host.alias);
      this.emitActualState(host.alias, beforeClose);
    };
    connection.onClose?.(markClosed);
    return {
      exec: (command, callback) => connection.exec(command, callback),
      openShell: (columns, rows, shellCommand, callback) => connection.openShell(columns, rows, shellCommand, callback),
      close: () => {
        try { connection.close(); } finally { markClosed(); }
      },
      onClose: (listener) => connection.onClose?.(listener),
      ...(connection.openSftp === undefined
        ? {}
        : { openSftp: (callback: Parameters<NonNullable<SshConnection["openSftp"]>>[0]) => connection.openSftp!(callback) })
    };
  }

  public shutdown(): void {
    const stoppable = this.adapter as Pick<SshAdapter, "connect"> & { shutdown?: () => void };
    stoppable.shutdown?.();
  }

  private emitActualState(host: string, previous: "unknown" | "connected" | "disconnected"): void {
    const current = this.registry.connectionState(host);
    if (current !== previous && (current === "connected" || current === "disconnected")) {
      this.onStateChange?.(host, current);
    }
  }
}
