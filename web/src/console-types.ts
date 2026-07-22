export type ConnectionState = "connecting" | "syncing" | "online" | "disconnected";

export interface ConsoleHost {
  readonly alias: string;
  readonly environment: "development" | "test";
  readonly platform: "linux" | "windows";
  readonly shell: "posix" | "powershell";
  readonly connectionState: "unknown" | "connecting" | "connected" | "disconnected";
}

export interface ConsoleOperation {
  readonly operationId: string;
  readonly source: "mcp" | "web";
  readonly kind: "command" | "profile" | "session" | "transfer" | "multi_host" | "unknown";
  readonly hosts: readonly string[];
  readonly state: string;
  readonly cancelRequested: boolean;
  readonly lastStateChangeAt: number;
  readonly outputTruncated: boolean;
  readonly progress: Readonly<Record<string, number>>;
}

export interface ConsoleSession {
  readonly sessionId: string;
  readonly host: string;
  readonly platform: "linux" | "windows";
  readonly shell: "posix" | "powershell";
  readonly state: string;
  readonly columns: number;
  readonly rows: number;
}

export interface ConsoleApproval {
  readonly approvalId: string;
  readonly operationId?: string;
  readonly state: string;
  readonly route: "dual" | "web_only";
  readonly kind: string;
  readonly hosts: readonly string[];
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface RuntimeSnapshot {
  readonly instanceId: string;
  readonly revision: number;
  readonly serviceState: "active" | "quiescing";
  readonly hosts: readonly ConsoleHost[];
  readonly operations: readonly ConsoleOperation[];
  readonly sessions: readonly ConsoleSession[];
  readonly approvals: readonly ConsoleApproval[];
  readonly profiles: readonly unknown[];
}

export interface OutputFrame {
  readonly stream: "stdout" | "stderr" | "pty";
  readonly cursor: number;
  readonly encoding: "utf8" | "base64";
  readonly data: string;
  readonly host?: string;
}

export interface OperationOutput {
  readonly frames: readonly OutputFrame[];
  readonly nextCursor: number;
  readonly minCursor: number;
  readonly truncated: boolean;
  readonly droppedBytes: number;
}
