import { createHash } from "node:crypto";

export type Platform = "linux" | "windows";
export type OperationIntentKind =
  | "raw_command"
  | "profile"
  | "session_open"
  | "session_input"
  | "session_resize"
  | "upload"
  | "download";
export type ExecutionMode = "parallel" | "sequential";
export type JsonValue = null | boolean | string | number | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface OperationIntentInput {
  readonly kind: OperationIntentKind;
  readonly hosts: readonly string[];
  readonly platformByHost: Readonly<Record<string, Platform>>;
  readonly payload: Readonly<Record<string, JsonValue>>;
  readonly executionMode?: ExecutionMode;
}

/**
 * 审批、执行和诊断共享同一深冻结对象；摘要不参与自身的 canonical JSON。
 */
export interface OperationIntent extends OperationIntentInput {
  readonly canonicalJson: string;
  readonly digest: string;
}

interface FactoryIntentState {
  readonly canonicalJson: string;
  readonly digest: string;
  mutationAttempted: boolean;
  consumed: boolean;
}

const operationIntentKinds = new Set<OperationIntentKind>([
  "raw_command",
  "profile",
  "session_open",
  "session_input",
  "session_resize",
  "upload",
  "download"
]);

const executionModes = new Set<ExecutionMode>(["parallel", "sequential"]);
const platforms = new Set<Platform>(["linux", "windows"]);
const factoryIntents = new WeakMap<object, FactoryIntentState>();

export function createOperationIntent(input: OperationIntentInput): OperationIntent {
  assertIntentInput(input);

  const semanticIntent = {
    kind: input.kind,
    hosts: [...input.hosts],
    platformByHost: cloneJsonObject(input.platformByHost),
    payload: cloneJsonObject(input.payload),
    ...(input.executionMode === undefined ? {} : { executionMode: input.executionMode })
  };
  const canonicalSerialized = canonicalJson(semanticIntent);
  const digest = createHash("sha256").update(canonicalSerialized, "utf8").digest("hex");
  const state: FactoryIntentState = {
    canonicalJson: canonicalSerialized,
    digest,
    mutationAttempted: false,
    consumed: false
  };
  const intent = protectAndFreeze({
    ...semanticIntent,
    canonicalJson: canonicalSerialized,
    digest
  }, state) as OperationIntent;

  factoryIntents.set(intent, state);
  return intent;
}

/**
 * 仅认可由本模块工厂创建且未被篡改的 Intent。运行时品牌不能由对象展开或类型断言伪造。
 */
export function isVerifiedOperationIntent(value: unknown): value is OperationIntent {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const intent = value as OperationIntent;
  const state = factoryIntents.get(intent);
  if (state === undefined || state.mutationAttempted || state.consumed || !isDeepFrozen(intent)) {
    return false;
  }

  try {
    assertIntentInput(intent);
    const canonicalSerialized = canonicalJson(semanticIntentOf(intent));
    const digest = createHash("sha256").update(canonicalSerialized, "utf8").digest("hex");
    return intent.canonicalJson === canonicalSerialized
      && intent.digest === digest
      && state.canonicalJson === canonicalSerialized
      && state.digest === digest;
  } catch {
    return false;
  }
}

/**
 * 接受后的 Intent 只能消费一次。该检查也会在副作用执行前重新核验完整性。
 */
export function consumeVerifiedOperationIntent(intent: OperationIntent): boolean {
  if (!isVerifiedOperationIntent(intent)) {
    return false;
  }
  const state = factoryIntents.get(intent);
  if (state === undefined) {
    return false;
  }
  state.consumed = true;
  return true;
}

/**
 * 以 UTF-8 字节编码前的稳定字符串表示 JSON：对象键字典序、数组保序、整数十进制且无 undefined。
 */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, new Set<object>());
}

function canonicalize(value: unknown, ancestors: Set<object>): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    throw new TypeError("canonical JSON 不允许 undefined");
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError("canonical JSON 仅允许安全整数");
    }
    return Object.is(value, -0) ? "0" : value.toString(10);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new TypeError("canonical JSON 不允许循环引用");
    }
    ancestors.add(value);
    try {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError("canonical JSON 不允许稀疏数组");
        }
        items.push(canonicalize(value[index], ancestors));
      }
      return `[${items.join(",")}]`;
    } finally {
      ancestors.delete(value);
    }
  }
  if (!isPlainObject(value)) {
    throw new TypeError("canonical JSON 仅允许普通对象");
  }
  if (ancestors.has(value)) {
    throw new TypeError("canonical JSON 不允许循环引用");
  }

  ancestors.add(value);
  try {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key], ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function assertIntentInput(input: OperationIntentInput): void {
  if (!operationIntentKinds.has(input.kind)) {
    throw new TypeError("OperationIntent.kind 不受支持");
  }
  if (!Array.isArray(input.hosts) || input.hosts.length === 0 || !isDenseArray(input.hosts)
    || input.hosts.some((host) => typeof host !== "string" || host.length === 0)) {
    throw new TypeError("OperationIntent.hosts 必须是非空字符串数组");
  }
  if (new Set(input.hosts).size !== input.hosts.length) {
    throw new TypeError("OperationIntent.hosts 不允许重复主机");
  }
  if (!isPlainObject(input.platformByHost)) {
    throw new TypeError("OperationIntent.platformByHost 必须是普通对象");
  }
  const platformHosts = Object.keys(input.platformByHost);
  if (platformHosts.length !== input.hosts.length || input.hosts.some((host) => !platformHosts.includes(host))) {
    throw new TypeError("OperationIntent.platformByHost 必须与 hosts 一一对应");
  }
  for (const platform of Object.values(input.platformByHost)) {
    if (!platforms.has(platform)) {
      throw new TypeError("OperationIntent.platformByHost 包含不受支持的平台");
    }
  }
  if (!isPlainObject(input.payload)) {
    throw new TypeError("OperationIntent.payload 必须是普通对象");
  }
  if (input.executionMode !== undefined && !executionModes.has(input.executionMode)) {
    throw new TypeError("OperationIntent.executionMode 不受支持");
  }

  canonicalJson(input.payload);
}

function cloneJsonObject<T extends Readonly<Record<string, JsonValue>>>(value: T): T {
  return cloneJsonValue(value) as T;
}

function cloneJsonValue(value: JsonValue): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonValue(item));
  }
  if (!isPlainObject(value)) {
    throw new TypeError("OperationIntent 仅允许 JSON 值");
  }

  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJsonValue(child as JsonValue)]));
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function semanticIntentOf(intent: OperationIntent): OperationIntentInput {
  return {
    kind: intent.kind,
    hosts: intent.hosts,
    platformByHost: intent.platformByHost,
    payload: intent.payload,
    ...(intent.executionMode === undefined ? {} : { executionMode: intent.executionMode })
  };
}

function protectAndFreeze<T>(value: T, state: FactoryIntentState): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  for (const [key, child] of Object.entries(value)) {
    Object.defineProperty(value, key, {
      value: protectAndFreeze(child, state),
      enumerable: true,
      writable: true,
      configurable: true
    });
  }
  Object.freeze(value);
  return new Proxy(value, {
    set: () => {
      state.mutationAttempted = true;
      return false;
    },
    deleteProperty: () => {
      state.mutationAttempted = true;
      return false;
    },
    defineProperty: () => {
      state.mutationAttempted = true;
      return false;
    },
    setPrototypeOf: () => {
      state.mutationAttempted = true;
      return false;
    }
  }) as T;
}

function isDenseArray(value: readonly unknown[]): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      return false;
    }
  }
  return true;
}

function isDeepFrozen(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value !== "object") {
    return true;
  }
  if (ancestors.has(value) || !Object.isFrozen(value)) {
    return false;
  }
  ancestors.add(value);
  try {
    return Object.values(value).every((child) => isDeepFrozen(child, ancestors));
  } finally {
    ancestors.delete(value);
  }
}
