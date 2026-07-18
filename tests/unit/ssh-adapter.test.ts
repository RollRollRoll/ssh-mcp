import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { ConnectConfig } from "ssh2";
import type { HostConfig } from "../../src/config/schema.js";
import { ErrorCodes } from "../../src/errors/error-codes.js";
import { StrictHostKeyVerifier } from "../../src/ssh/host-key.js";
import { PlatformProbeError, runPlatformProbe } from "../../src/ssh/platform-probe.js";
import { SshAdapter, type SshClientLike } from "../../src/ssh/ssh-adapter.js";
import { TrustStore } from "../../src/ssh/trust-store.js";

class FakeChannel extends EventEmitter {
  public readonly stderr = new EventEmitter();
}

class FakeClient extends EventEmitter implements SshClientLike {
  public config: ConnectConfig | undefined;
  public readonly commands: string[] = [];
  public ended = false;

  public connect(config: ConnectConfig): this {
    this.config = config;
    return this;
  }

  public exec(command: string, callback: (error: Error | undefined, channel: FakeChannel) => void): this {
    this.commands.push(command);
    const channel = new FakeChannel();
    callback(undefined, channel);
    setImmediate(() => {
      channel.emit("data", Buffer.from("SSH_MCP_PLATFORM=linux\nSSH_MCP_SHELL=posix\n"));
      channel.emit("close", 0, undefined);
    });
    return this;
  }

  public end(): this {
    this.ended = true;
    return this;
  }

  public destroy(): this {
    this.ended = true;
    return this;
  }
}

function host(auth: HostConfig["auth"] = { type: "privateKeyFile", path: "/keys/client" }): HostConfig {
  return {
    alias: "linux-test",
    environment: "test",
    platform: "linux",
    host: "127.0.0.1",
    port: 2222,
    username: "test",
    auth,
    shell: { type: "posix", command: "/bin/sh" },
    remoteRoots: ["/tmp"]
  };
}

function rawHostKey(): Buffer {
  const name = Buffer.from("ssh-ed25519");
  const raw = Buffer.alloc(4 + name.length + 32, 5);
  raw.writeUInt32BE(name.length, 0);
  name.copy(raw, 4);
  return raw;
}

describe("platform probe", () => {
  it("Linux 只执行登记 Shell 的固定 -c 脚本并核对 marker", async () => {
    const client = new FakeClient();
    await runPlatformProbe(client, host());

    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]).toMatch(/^'\/bin\/sh' -c '/);
    expect(client.commands[0]).toContain("uname -s");
  });

  it("退出码、marker 或总输出超过 4KiB 时返回 PLATFORM_MISMATCH", async () => {
    const client = new FakeClient();
    client.exec = ((_command: string, callback: (error: Error | undefined, channel: FakeChannel) => void) => {
      const channel = new FakeChannel();
      callback(undefined, channel);
      setImmediate(() => {
        channel.emit("data", Buffer.alloc(4097));
        channel.emit("close", 0, undefined);
      });
      return client;
    }) as FakeClient["exec"];

    await expect(runPlatformProbe(client, host())).rejects.toBeInstanceOf(PlatformProbeError);
    await expect(runPlatformProbe(client, host())).rejects.toMatchObject({ code: ErrorCodes.PLATFORM_MISMATCH });
  });
});

describe("SshAdapter", () => {
  it("主机确认期间暂停 15 秒活动计时，接受后恢复认证与探针预算", async () => {
    const client = new FakeClient();
    let accept: (() => void) | undefined;
    const activeTimers = new Set<() => void>();
    const adapter = new SshAdapter({
      verify: async (_target, _rawKey, lifecycle) => {
        lifecycle.onConfirmationStart?.();
        try {
          await new Promise<void>((resolve) => { accept = resolve; });
        } finally {
          lifecycle.onConfirmationEnd?.();
        }
      }
    }, {
      createClient: () => client,
      readFile: async () => Buffer.from("private-key"),
      stat: async () => ({ isSocket: () => true }),
      platform: "linux",
      clock: {
        now: () => 0,
        setTimeout: (callback) => {
          activeTimers.add(callback);
          return callback;
        },
        clearTimeout: (timer) => { activeTimers.delete(timer as () => void); }
      }
    });

    const pending = adapter.connect(host());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(activeTimers.size).toBe(1);
    (client.config?.hostVerifier as (key: Buffer, verify: (accepted: boolean) => void) => void)(rawHostKey(), (accepted) => {
      if (accepted) client.emit("ready");
    });
    expect(activeTimers.size).toBe(0);
    while (accept === undefined) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    accept();

    await expect(pending).resolves.toBeDefined();
  });

  it("底层在 verifier 永不结束时立即取消、销毁并拒绝", async () => {
    const client = new FakeClient();
    let aborted = false;
    const adapter = new SshAdapter({
      verify: async (_target, _rawKey, signal) => await new Promise<void>(() => {
        signal.addEventListener("abort", () => {
          aborted = true;
        }, { once: true });
      })
    }, {
      createClient: () => client,
      readFile: async () => Buffer.from("private-key"),
      stat: async () => ({ isSocket: () => true }),
      platform: "linux"
    });

    const pending = adapter.connect(host());
    const rejected = expect(pending).rejects.toMatchObject({ code: ErrorCodes.CONNECTION_TIMEOUT });
    await new Promise<void>((resolve) => setImmediate(resolve));
    (client.config?.hostVerifier as (key: Buffer, verify: (accepted: boolean) => void) => void)(rawHostKey(), () => undefined);
    client.emit("error", Object.assign(new Error("handshake timeout"), { level: "client-timeout" }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(aborted).toBe(true);
    await rejected;
    expect(client.ended).toBe(true);
  });

  it("泛型 verifier 未声明确认窗口时持续消耗连接预算", async () => {
    const client = new FakeClient();
    const timers: Array<() => void> = [];
    const adapter = new SshAdapter({ verify: async () => await new Promise<void>(() => undefined) }, {
      createClient: () => client,
      readFile: async () => Buffer.from("private-key"),
      stat: async () => ({ isSocket: () => true }),
      platform: "linux",
      clock: {
        now: () => 0,
        setTimeout: (callback) => {
          timers.push(callback);
          return callback;
        },
        clearTimeout: () => undefined
      }
    });

    const pending = adapter.connect(host(), 15);
    const rejected = expect(pending).rejects.toMatchObject({ code: ErrorCodes.CONNECTION_TIMEOUT });
    await new Promise<void>((resolve) => setImmediate(resolve));
    (client.config?.hostVerifier as (key: Buffer, verify: (accepted: boolean) => void) => void)(rawHostKey(), () => undefined);
    expect(timers).toHaveLength(1);
    timers[0]?.();

    await rejected;
    expect(client.ended).toBe(true);
  });

  it("确认暂停时预算已耗尽，成功 verifier 也只拒绝 host key", async () => {
    const client = new FakeClient();
    const timers: Array<() => void> = [];
    const accepted: boolean[] = [];
    let now = 0;
    const adapter = new SshAdapter({
      verify: async (_target, _rawKey, lifecycle) => {
        now = 15;
        lifecycle.onConfirmationStart();
        lifecycle.onConfirmationEnd();
      }
    }, {
      createClient: () => client,
      readFile: async () => Buffer.from("private-key"),
      stat: async () => ({ isSocket: () => true }),
      platform: "linux",
      clock: {
        now: () => now,
        setTimeout: (callback) => {
          timers.push(callback);
          return callback;
        },
        clearTimeout: () => undefined
      }
    });

    const pending = adapter.connect(host(), 15);
    const rejected = expect(pending).rejects.toMatchObject({ code: ErrorCodes.CONNECTION_TIMEOUT });
    await new Promise<void>((resolve) => setImmediate(resolve));
    (client.config?.hostVerifier as (key: Buffer, verify: (accepted: boolean) => void) => void)(rawHostKey(), (value) => {
      accepted.push(value);
      if (value) client.emit("ready");
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(accepted).toEqual([false]);
    expect(client.commands).toEqual([]);
    await rejected;
  });

  it("默认活动计时使用单调时钟而非墙钟", async () => {
    const source = await import("node:fs/promises").then(async (fileSystem) =>
      await fileSystem.readFile("src/ssh/ssh-adapter.ts", "utf8")
    );

    expect(source).toContain('from "node:perf_hooks"');
    expect(source).not.toContain("now: () => Date.now()");
  });

  it("认证后平台探针 Channel 永不关闭时在连接预算内超时并销毁连接", async () => {
    const client = new FakeClient();
    const timers: Array<() => void> = [];
    client.exec = ((_command: string, callback: (error: Error | undefined, channel: FakeChannel) => void) => {
      callback(undefined, new FakeChannel());
      return client;
    }) as FakeClient["exec"];
    const adapter = new SshAdapter({ verify: async () => undefined }, {
      createClient: () => client,
      readFile: async () => Buffer.from("private-key"),
      stat: async () => ({ isSocket: () => true }),
      platform: "linux",
      clock: {
        now: () => 0,
        setTimeout: (callback) => {
          timers.push(callback);
          return callback;
        },
        clearTimeout: () => undefined
      }
    });

    const pending = adapter.connect(host(), 15);
    await new Promise<void>((resolve) => setImmediate(resolve));
    client.emit("ready");
    timers[0]?.();

    await expect(pending).rejects.toMatchObject({ code: ErrorCodes.CONNECTION_TIMEOUT });
    expect(client.ended).toBe(true);
  });

  it("每次连接安装异步 hostVerifier，接受并持久化后才进入认证和探针", async () => {
    const client = new FakeClient();
    let acceptConfirmation: (() => void) | undefined;
    const trustStore = new TrustStore("/memory/trust", {
      readFile: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      open: async () => ({ writeFile: async () => undefined, sync: async () => undefined, close: async () => undefined }),
      rename: async () => undefined,
      unlink: async () => undefined
    });
    const verifier = new StrictHostKeyVerifier(trustStore, {
      supportsForm: () => true,
      confirm: async () => await new Promise((resolve) => {
        acceptConfirmation = () => resolve("accept");
      })
    });
    const adapter = new SshAdapter(verifier, {
      createClient: () => client,
      readFile: async () => Buffer.from("private-key"),
      stat: async () => ({ isSocket: () => true }),
      platform: "linux"
    });

    const pending = adapter.connect(host());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(client.config?.hostVerifier).toBeTypeOf("function");
    expect(client.config).not.toHaveProperty("sock");
    expect(client.config).not.toHaveProperty("agentForward");
    expect(client.config?.readyTimeout).toBe(0);
    (client.config?.hostVerifier as (key: Buffer, verify: (accepted: boolean) => void) => void)(rawHostKey(), (accepted) => {
      if (accepted) client.emit("ready");
    });
    expect(client.commands).toEqual([]);
    while (acceptConfirmation === undefined) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    acceptConfirmation();

    await expect(pending).resolves.toBeDefined();
    expect(client.commands).toHaveLength(1);
    expect(client.config?.privateKey).toEqual(Buffer.from("private-key"));
    const handler = client.config?.authHandler as (
      methodsLeft: Array<"publickey" | "password" | "keyboard-interactive"> | null,
      partial: boolean | null,
      next: (method: false | string) => void
    ) => void;
    let selected: false | string | undefined;
    handler(null, null, (method) => { selected = method; });
    expect(selected).toBe("publickey");
    handler(["password", "keyboard-interactive"], false, (method) => { selected = method; });
    expect(selected).toBe(false);
  });

  it("缺失 Agent 在 connect 前稳定映射 AUTH_UNAVAILABLE", async () => {
    const client = new FakeClient();
    const adapter = new SshAdapter({ verify: async () => undefined }, {
      createClient: () => client,
      readFile: async () => Buffer.alloc(0),
      stat: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      platform: "linux"
    });

    await expect(adapter.connect(host({ type: "agent", socket: "/missing/agent.sock" })))
      .rejects.toMatchObject({ code: ErrorCodes.AUTH_UNAVAILABLE });
    expect(client.config).toBeUndefined();
  });

  it("服务端只提供交互认证时返回 INTERACTIVE_AUTH_UNSUPPORTED", async () => {
    const client = new FakeClient();
    const adapter = new SshAdapter({ verify: async () => undefined }, {
      createClient: () => client,
      readFile: async () => Buffer.from("private-key"),
      stat: async () => ({ isSocket: () => true }),
      platform: "linux"
    });

    const pending = adapter.connect(host());
    await new Promise<void>((resolve) => setImmediate(resolve));
    const handler = client.config?.authHandler as (
      methodsLeft: string[], partial: boolean, next: (method: false | string) => void
    ) => void;
    handler(["password", "keyboard-interactive"], false, () => undefined);
    client.emit("error", Object.assign(new Error("auth failed"), { level: "client-authentication" }));

    await expect(pending).rejects.toMatchObject({ code: ErrorCodes.INTERACTIVE_AUTH_UNSUPPORTED });
  });

  it("连接超时后继续消费底层清理阶段的后续错误", async () => {
    const client = new FakeClient();
    const adapter = new SshAdapter({ verify: async () => undefined }, {
      createClient: () => client,
      readFile: async () => Buffer.from("private-key"),
      stat: async () => ({ isSocket: () => true }),
      platform: "linux"
    });

    const pending = adapter.connect(host());
    await new Promise<void>((resolve) => setImmediate(resolve));
    client.emit("error", Object.assign(new Error("Timed out while waiting for handshake"), { level: "client-timeout" }));

    await expect(pending).rejects.toMatchObject({ code: ErrorCodes.CONNECTION_TIMEOUT });
    expect(() => client.emit("error", Object.assign(new Error("Connection lost before handshake"), {
      level: "protocol",
      fatal: true
    }))).not.toThrow();
  });
});
