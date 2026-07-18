import type { HostConfig, LowRiskParameter, LowRiskProfile } from "../config/schema.js";
import { createMcpOperationError, ErrorCodes, type McpOperationError } from "../errors/error-contract.js";
import { lexicalPathHandle } from "../paths/path-guard.js";

export interface VerifiedProfileValue {
  readonly parameter: LowRiskParameter;
  readonly value: string | number | boolean;
}

/** 仅由 PolicyEngine 签发，编译器会拒绝任意仿造对象。 */
export interface VerifiedProfileMatch {
  readonly profile: LowRiskProfile;
  readonly host: HostConfig;
  readonly values: readonly VerifiedProfileValue[];
}

export type PolicyDecision =
  | Readonly<{ matched: true; match: VerifiedProfileMatch }>
  | Readonly<{ matched: false; error: McpOperationError }>;

const verifiedMatches = new WeakSet<object>();

export function isVerifiedProfileMatch(value: unknown): value is VerifiedProfileMatch {
  return typeof value === "object" && value !== null && verifiedMatches.has(value);
}

/** 启动时冻结规则；匹配过程只有纯字符串和词法路径判断，绝不连接或审批。 */
export class PolicyEngine {
  private readonly profilesById: ReadonlyMap<string, LowRiskProfile>;

  public constructor(profiles: readonly LowRiskProfile[]) {
    const frozenProfiles = cloneAndFreeze(profiles);
    this.profilesById = new Map(frozenProfiles.map((profile) => [profile.id, profile]));
  }

  public hasProfile(profileId: string): boolean {
    return this.profilesById.has(profileId);
  }

  public evaluate(input: { readonly profileId: string; readonly host: HostConfig; readonly parameters: unknown }): PolicyDecision {
    const profile = this.profilesById.get(input.profileId);
    if (profile === undefined) return rejection(ErrorCodes.POLICY_NOT_FOUND);
    if (!this.matchesHost(profile, input.host) || !isPlainRecord(input.parameters)) return rejection(ErrorCodes.POLICY_REQUIRES_APPROVAL);

    const parameters = input.parameters;
    const expectedNames = new Set(profile.parameters.map((parameter) => parameter.name));
    if (Object.keys(parameters).some((name) => !expectedNames.has(name))) return rejection(ErrorCodes.POLICY_REQUIRES_APPROVAL);

    const values: VerifiedProfileValue[] = [];
    for (const parameter of profile.parameters) {
      const hasValue = Object.prototype.hasOwnProperty.call(parameters, parameter.name);
      if (!hasValue) {
        if (parameter.required) return rejection(ErrorCodes.POLICY_REQUIRES_APPROVAL);
        continue;
      }
      const checked = this.validateValue(parameter, parameters[parameter.name], input.host);
      if (checked === undefined) return rejection(ErrorCodes.POLICY_REQUIRES_APPROVAL);
      values.push(Object.freeze({ parameter, value: checked }));
    }

    const match = deepFreeze({ profile, host: cloneAndFreeze(input.host), values });
    verifiedMatches.add(match);
    return Object.freeze({ matched: true, match });
  }

  private matchesHost(profile: LowRiskProfile, host: HostConfig): boolean {
    const expectedShell = profile.platform === "linux" ? "posix" : "powershell";
    return profile.hostAliases.includes(host.alias)
      && profile.platform === host.platform
      && host.shell.type === expectedShell;
  }

  private validateValue(parameter: LowRiskParameter, value: unknown, host: HostConfig): string | number | boolean | undefined {
    switch (parameter.type) {
      case "enum":
        return typeof value === "string" && parameter.values.includes(value) ? value : undefined;
      case "integer":
        return typeof value === "number" && Number.isSafeInteger(value)
          && (parameter.minimum === undefined || value >= parameter.minimum)
          && (parameter.maximum === undefined || value <= parameter.maximum) ? value : undefined;
      case "boolean":
        return typeof value === "boolean" ? value : undefined;
      case "remotePath":
        if (typeof value !== "string" || /[\u0000\r\n]/.test(value)) return undefined;
        try {
          lexicalPathHandle(value, host.remoteRoots, host.platform === "linux" ? "posix" : "win32");
          return value;
        } catch {
          return undefined;
        }
    }
  }
}

function rejection(code: typeof ErrorCodes.POLICY_NOT_FOUND | typeof ErrorCodes.POLICY_REQUIRES_APPROVAL): PolicyDecision {
  return Object.freeze({
    matched: false,
    error: createMcpOperationError({ code, message: code, finalState: "failed", retriable: false, sideEffects: "none" })
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneAndFreeze<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
