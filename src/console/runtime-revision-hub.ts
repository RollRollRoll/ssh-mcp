export type RuntimeRevisionScope = "service" | "hosts" | "operations" | "sessions" | "approvals" | "profiles";

export interface RuntimeRevision {
  readonly revision: number;
  readonly scopes: readonly RuntimeRevisionScope[];
}

export interface RuntimeRevisionHubOptions {
  readonly schedule?: (callback: () => void) => void;
  readonly maxSubscribers?: number;
}

const scopeOrder: readonly RuntimeRevisionScope[] = Object.freeze([
  "service", "hosts", "operations", "sessions", "approvals", "profiles"
]);

/** 只维护失效版本，不保存操作、输出或审批事件副本。 */
export class RuntimeRevisionHub {
  private readonly schedule: (callback: () => void) => void;
  private readonly maxSubscribers: number;
  private readonly subscribers = new Set<(event: RuntimeRevision) => void>();
  private readonly pendingScopes = new Set<RuntimeRevisionScope>();
  private current = 0;
  private scheduled = false;
  private closed = false;

  public constructor(options: RuntimeRevisionHubOptions = {}) {
    this.schedule = options.schedule ?? queueMicrotask;
    this.maxSubscribers = options.maxSubscribers ?? 32;
    if (!Number.isSafeInteger(this.maxSubscribers) || this.maxSubscribers <= 0) {
      throw new RangeError("运行时订阅上限必须是正安全整数");
    }
  }

  public get revision(): number {
    return this.current;
  }

  public invalidate(scope: RuntimeRevisionScope): void {
    if (this.closed) return;
    this.pendingScopes.add(scope);
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => this.flush());
  }

  public subscribe(listener: (event: RuntimeRevision) => void): () => void {
    if (this.closed) throw new Error("运行时修订中心已关闭");
    if (this.subscribers.size >= this.maxSubscribers) throw new Error("运行时订阅数已达上限");
    this.subscribers.add(listener);
    return () => { this.subscribers.delete(listener); };
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pendingScopes.clear();
    this.subscribers.clear();
  }

  private flush(): void {
    this.scheduled = false;
    if (this.closed || this.pendingScopes.size === 0) return;
    this.current += 1;
    const scopes = Object.freeze(scopeOrder.filter((scope) => this.pendingScopes.has(scope)));
    this.pendingScopes.clear();
    const event = Object.freeze({ revision: this.current, scopes });
    for (const listener of [...this.subscribers]) {
      try { listener(event); } catch { /* 单个 SSE 观察者不得阻止其他订阅者。 */ }
    }
  }
}
