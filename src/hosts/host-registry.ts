import type { ConnectionState, HostConfig } from "../config/schema.js";

export interface HostSummary {
  readonly alias: string;
  readonly environment: "development" | "test";
  readonly platform: "linux" | "windows";
  readonly shell: "posix" | "powershell";
  readonly connectionState: ConnectionState;
}

export class HostRegistry {
  private readonly hostsByAlias: ReadonlyMap<string, HostConfig>;
  private readonly connectionStates = new Map<string, ConnectionState>();

  public constructor(hosts: readonly HostConfig[]) {
    const entries = hosts.map((host) => [host.alias, cloneAndFreeze(host)] as const);
    this.hostsByAlias = new Map(entries);
  }

  public get(alias: string): HostConfig | undefined {
    return this.hostsByAlias.get(alias);
  }

  public list(): readonly HostSummary[] {
    return Object.freeze([...this.hostsByAlias.values()]
      .map((host) => Object.freeze({
        alias: host.alias,
        environment: host.environment,
        platform: host.platform,
        shell: host.shell.type,
        connectionState: this.connectionStates.get(host.alias) ?? "unknown"
      }))
      .sort((left, right) => compareAliases(left.alias, right.alias)));
  }

  public setConnectionState(alias: string, connectionState: ConnectionState): void {
    if (!this.hostsByAlias.has(alias)) {
      throw new Error(`未登记主机：${alias}`);
    }
    this.connectionStates.set(alias, connectionState);
  }
}

function compareAliases(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function cloneAndFreeze<T>(value: T): T {
  const copy = structuredClone(value);
  freezeRecursively(copy);
  return copy;
}

function freezeRecursively(value: unknown): void {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      freezeRecursively(child);
    }
    Object.freeze(value);
  }
}
