import type { ApprovalCoordinator, ApprovalSafeSnapshot } from "../approval/approval-coordinator.js";
import type { LowRiskParameter } from "../config/schema.js";
import type { HostRegistry, HostSummary } from "../hosts/host-registry.js";
import type { ConsoleOperationSummary, OperationManager } from "../operations/operation-manager.js";
import type { SessionManager, SessionSnapshot } from "../sessions/session-manager.js";
import type { RuntimeRevisionHub } from "./runtime-revision-hub.js";

export interface ConsoleApprovalView {
  readonly approvalId: string;
  readonly operationId?: string;
  readonly revision: number;
  readonly route: "dual" | "web_only";
  readonly state: ApprovalSafeSnapshot["state"];
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly kind: ApprovalSafeSnapshot["kind"];
  readonly digest: string;
  readonly hosts: readonly string[];
  readonly platformByHost: ApprovalSafeSnapshot["platformByHost"];
  readonly mcpChannelState?: ApprovalSafeSnapshot["mcpChannelState"];
  readonly resolvedAt?: number;
  readonly resolvedBy?: ApprovalSafeSnapshot["resolvedBy"];
  readonly errorCode?: ApprovalSafeSnapshot["errorCode"];
}

export interface ConsoleProfileSummary {
  readonly id: string;
  readonly platform: "linux" | "windows";
  readonly hostAliases: readonly string[];
  readonly parameters: readonly LowRiskParameter[];
}

export interface RuntimeSnapshot {
  readonly instanceId: string;
  readonly revision: number;
  readonly serviceState: "active" | "quiescing";
  readonly hosts: readonly HostSummary[];
  readonly operations: readonly ConsoleOperationSummary[];
  readonly sessions: readonly SessionSnapshot[];
  readonly approvals: readonly ConsoleApprovalView[];
  readonly profiles: readonly ConsoleProfileSummary[];
}

export interface RuntimeSnapshotProjectorOptions {
  readonly instanceId: string;
  readonly revisions: RuntimeRevisionHub;
  readonly hosts: HostRegistry;
  readonly operations: OperationManager;
  readonly sessions: SessionManager;
  readonly approvals: ApprovalCoordinator;
  readonly profiles?: () => readonly ConsoleProfileSummary[];
}

/** 从当前进程事实源即时生成白名单快照；自身不缓存业务状态。 */
export class RuntimeSnapshotProjector {
  private serviceState: RuntimeSnapshot["serviceState"] = "active";

  public constructor(private readonly options: RuntimeSnapshotProjectorOptions) {
    if (options.instanceId.length === 0) throw new RangeError("控制台实例 ID 不能为空");
  }

  public setQuiescing(): void {
    if (this.serviceState === "quiescing") return;
    this.serviceState = "quiescing";
    this.options.revisions.invalidate("service");
  }

  public snapshot(): RuntimeSnapshot {
    return Object.freeze({
      instanceId: this.options.instanceId,
      revision: this.options.revisions.revision,
      serviceState: this.serviceState,
      hosts: this.options.hosts.list(),
      operations: this.options.operations.listForConsole(),
      sessions: this.options.sessions.list(),
      approvals: projectApprovals(this.options.approvals.list()),
      profiles: projectProfiles(this.options.profiles?.() ?? [])
    });
  }
}

function projectApprovals(records: readonly ApprovalSafeSnapshot[]): readonly ConsoleApprovalView[] {
  return Object.freeze(records.map((record) => Object.freeze({
    approvalId: record.approvalId,
    ...(record.operationId === undefined ? {} : { operationId: record.operationId }),
    revision: record.revision,
    route: record.route,
    state: record.state,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    kind: record.kind,
    digest: record.digest,
    hosts: Object.freeze([...record.hosts]),
    platformByHost: Object.freeze({ ...record.platformByHost }),
    ...(record.mcpChannelState === undefined ? {} : { mcpChannelState: record.mcpChannelState }),
    ...(record.resolvedAt === undefined ? {} : { resolvedAt: record.resolvedAt }),
    ...(record.resolvedBy === undefined ? {} : { resolvedBy: record.resolvedBy }),
    ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode })
  })).sort(compareApprovals));
}

function projectProfiles(records: readonly ConsoleProfileSummary[]): readonly ConsoleProfileSummary[] {
  return Object.freeze(records.map((profile) => Object.freeze({
    id: profile.id,
    platform: profile.platform,
    hostAliases: Object.freeze([...profile.hostAliases]),
    parameters: Object.freeze(profile.parameters.map((parameter) => deepFreezeClone(parameter)))
  })).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function compareApprovals(left: ConsoleApprovalView, right: ConsoleApprovalView): number {
  if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt;
  return left.approvalId < right.approvalId ? -1 : left.approvalId > right.approvalId ? 1 : 0;
}

function deepFreezeClone<T>(value: T): T {
  const clone = structuredClone(value);
  freezeRecursively(clone);
  return clone;
}

function freezeRecursively(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value)) freezeRecursively(child);
  Object.freeze(value);
}
