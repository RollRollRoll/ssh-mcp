import type { SshMcpConfig } from "./schema.js";
import { ConfigLoader } from "./loader.js";
import { HostRegistry } from "../hosts/host-registry.js";
import { PolicyEngine } from "../policy/policy-engine.js";

export interface ConfigReloadSnapshot {
  readonly hostCount: number;
  readonly profileCount: number;
}

export class ConfigRestartRequiredError extends Error {
  public constructor() {
    super("配置包含只能在进程启动时装配的字段变更");
    this.name = "ConfigRestartRequiredError";
  }
}

/** 只热替换新操作会读取的授权快照；进程级资源预算与本地边界仍要求重启。 */
export class RuntimeConfigReloader {
  private current: SshMcpConfig;

  public constructor(
    private readonly loader: ConfigLoader,
    initial: SshMcpConfig,
    private readonly registry: HostRegistry,
    private readonly policy: PolicyEngine
  ) {
    this.current = initial;
  }

  public reload(): ConfigReloadSnapshot {
    const candidate = this.loader.reload();
    if (!sameProcessConfig(this.current, candidate)) {
      throw new ConfigRestartRequiredError();
    }

    this.registry.replace(candidate.hosts);
    this.policy.replace(candidate.lowRiskProfiles);
    this.current = candidate;
    return Object.freeze({
      hostCount: candidate.hosts.length,
      profileCount: candidate.lowRiskProfiles.length
    });
  }
}

function sameProcessConfig(current: SshMcpConfig, candidate: SshMcpConfig): boolean {
  return current.version === candidate.version
    && current.trustStore === candidate.trustStore
    && JSON.stringify(current.localRoots) === JSON.stringify(candidate.localRoots)
    && JSON.stringify(current.limits) === JSON.stringify(candidate.limits);
}
