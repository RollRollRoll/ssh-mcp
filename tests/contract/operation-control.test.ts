import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  OperationManager,
  type MonotonicClock,
  type OperationRunner
} from "../../src/operations/operation-manager.js";
import { createServer } from "../../src/server.js";

describe("operation_get / operation_cancel", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); });

  it("operation_get 使用字节预算、报告截断，并将非法参数映射为稳定错误", async () => {
    const manager = new OperationManager({ idFactory: () => "operation-1", outputBufferBytes: 4 });
    manager.create({ initialState: "running" });
    manager.appendOutput("operation-1", "stdout", Buffer.from("hello"), { host: "host-1" });
    const client = await connect(manager);

    await expect(client.callTool({ name: "operation_get", arguments: { operationId: "operation-1" } }))
      .resolves.toMatchObject({ structuredContent: {
        state: "running", minCursor: 1, droppedBytes: 1, truncated: true,
        frames: [{ stream: "stdout", cursor: 1, encoding: "utf8", data: "ello", host: "host-1" }]
      } });
    await expect(client.callTool({ name: "operation_get", arguments: { operationId: "operation-1", cursor: 6 } }))
      .resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "INVALID_CURSOR" } } });
    await expect(client.callTool({ name: "operation_get", arguments: { operationId: "operation-1", maxBytes: 262_145 } }))
      .resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "INVALID_ARGUMENT" } } });
  });

  it("operation_cancel 对终态幂等，运行中立即返回当前公开状态", async () => {
    const manager = new OperationManager({ idFactory: () => "operation-2" });
    manager.create({ initialState: "running" });
    const client = await connect(manager);

    await expect(client.callTool({ name: "operation_cancel", arguments: { operationId: "operation-2" } }))
      .resolves.toMatchObject({ structuredContent: { operationId: "operation-2", state: "cancelled" } });
    await expect(client.callTool({ name: "operation_cancel", arguments: { operationId: "operation-2" } }))
      .resolves.toMatchObject({ structuredContent: { operationId: "operation-2", state: "cancelled" } });
  });

  it("列出工具缓存严格输出契约后，仍可读取超时未确认的详情", async () => {
    const clock = new FakeClock();
    const manager = new OperationManager({
      clock,
      idFactory: () => "timeout-unknown"
    });
    manager.create({
      initialState: "running",
      runner: new FakeRunner(),
      timeoutKind: "transfer",
      timeoutMs: 1
    });
    const client = await connect(manager);
    await client.listTools();

    clock.advance(1);
    clock.advance(10_000);
    await expect(client.callTool({ name: "operation_get", arguments: { operationId: "timeout-unknown" } }))
      .resolves.toMatchObject({
        structuredContent: {
          operationId: "timeout-unknown",
          state: "unknown",
          error: {
            code: "STATE_UNKNOWN",
            details: { reason: "timeout", timeoutKind: "transfer" }
          }
        }
      });
  });

  async function connect(manager: OperationManager): Promise<Client> {
    const server = createServer(undefined, manager);
    const client = new Client({ name: "contract-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closers.push(async () => { await client.close(); await server.close(); });
    return client;
  }
});

class FakeClock implements MonotonicClock {
  private nowMs = 0;
  private sequence = 0;
  private readonly timers = new Map<number, { due: number; callback: () => void }>();

  public now(): number { return this.nowMs; }
  public setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.sequence;
    this.timers.set(id, { due: this.nowMs + delayMs, callback });
    return id;
  }
  public clearTimeout(timer: unknown): void { this.timers.delete(timer as number); }
  public advance(delayMs: number): void {
    this.nowMs += delayMs;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.due <= this.nowMs);
      if (due.length === 0) return;
      for (const [id, timer] of due) { this.timers.delete(id); timer.callback(); }
    }
  }
}

class FakeRunner implements OperationRunner {
  public cancel(): void {}
}
