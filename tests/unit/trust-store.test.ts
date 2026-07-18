import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ErrorCodes } from "../../src/errors/error-codes.js";
import {
  HOST_CONFIRMATION_TIMEOUT_MS,
  StrictHostKeyVerifier,
  describeHostKey,
  type TrustConfirmation
} from "../../src/ssh/host-key.js";
import { TrustStore, TrustStoreError } from "../../src/ssh/trust-store.js";

const identity = { alias: "linux-test", configuredHost: "127.0.0.1", port: 2222 } as const;

function rawHostKey(algorithm = "ssh-ed25519", fill = 7): Buffer {
  const name = Buffer.from(algorithm, "utf8");
  const raw = Buffer.alloc(4 + name.length + 32, fill);
  raw.writeUInt32BE(name.length, 0);
  name.copy(raw, 4);
  return raw;
}

async function temporaryStorePath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "ssh-mcp-trust-")), "trust.json");
}

describe("主机密钥描述", () => {
  it("从原始 SSH key blob 提取算法并生成 OpenSSH SHA-256 指纹", () => {
    const rawKey = rawHostKey();

    expect(describeHostKey(rawKey)).toEqual({
      algorithm: "ssh-ed25519",
      fingerprint: `SHA256:${createHash("sha256").update(rawKey).digest("base64").replace(/=+$/, "")}`,
      rawKey
    });
  });

  it("拒绝算法字段越界或非规范 UTF-8 的原始 key", () => {
    expect(() => describeHostKey(Buffer.from([0, 0, 0, 9, 1]))).toThrow("主机密钥格式无效");
    expect(() => describeHostKey(Buffer.from([0, 0, 0, 1, 0xff]))).toThrow("主机密钥格式无效");
  });
});

describe("TrustStore", () => {
  it("以 version 1 写入公开密钥，并能按 alias|configuredHost|port 重读", async () => {
    const path = await temporaryStorePath();
    const store = new TrustStore(path, undefined, () => "2026-07-18T01:02:03.000Z");
    const key = describeHostKey(rawHostKey());

    await store.remember(identity, key);

    const record = await store.lookup(identity);
    expect(record).toEqual({ ...key, confirmedAt: "2026-07-18T01:02:03.000Z" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      hosts: {
        "linux-test|127.0.0.1|2222": {
          algorithm: "ssh-ed25519",
          fingerprint: key.fingerprint,
          publicKeyBase64: key.rawKey.toString("base64"),
          confirmedAt: "2026-07-18T01:02:03.000Z"
        }
      }
    });
  });

  it("损坏、版本错误和锁冲突均以 TRUST_STORE_ERROR 关闭失败", async () => {
    const corruptPath = await temporaryStorePath();
    await writeFile(corruptPath, "{not-json", { mode: 0o600 });
    await expect(new TrustStore(corruptPath).lookup(identity)).rejects.toMatchObject({
      code: ErrorCodes.TRUST_STORE_ERROR
    });

    const versionPath = await temporaryStorePath();
    await writeFile(versionPath, JSON.stringify({ version: 2, hosts: {} }), { mode: 0o600 });
    await expect(new TrustStore(versionPath).lookup(identity)).rejects.toBeInstanceOf(TrustStoreError);

    const lockedPath = await temporaryStorePath();
    await writeFile(`${lockedPath}.lock`, "locked", { mode: 0o600 });
    await expect(new TrustStore(lockedPath).remember(identity, describeHostKey(rawHostKey()))).rejects.toMatchObject({
      code: ErrorCodes.TRUST_STORE_ERROR
    });

    const legacyFieldPath = await temporaryStorePath();
    await writeFile(legacyFieldPath, JSON.stringify({
      version: 1,
      hosts: {
        "linux-test|127.0.0.1|2222": {
          algorithm: "ssh-ed25519",
          fingerprint: "SHA256:test",
          publicKey: rawHostKey().toString("base64"),
          confirmedAt: "2026-07-18T01:02:03.000Z"
        }
      }
    }), { mode: 0o600 });
    await expect(new TrustStore(legacyFieldPath).lookup(identity)).rejects.toBeInstanceOf(TrustStoreError);
  });

  it("持锁后重读，避免覆盖另一个写入者的新记录", async () => {
    const path = await temporaryStorePath();
    const first = new TrustStore(path);
    const second = new TrustStore(path);

    await first.remember(identity, describeHostKey(rawHostKey("ssh-ed25519", 1)));
    await second.remember(
      { alias: "other", configuredHost: "example.test", port: 22 },
      describeHostKey(rawHostKey("ssh-ed25519", 2))
    );

    const parsed = JSON.parse(await readFile(path, "utf8")) as { hosts: Record<string, unknown> };
    expect(Object.keys(parsed.hosts)).toEqual([
      "linux-test|127.0.0.1|2222",
      "other|example.test|22"
    ]);
  });

  it("取消发生在原子替换前时不调用 rename，也不留下信任记录", async () => {
    const controller = new AbortController();
    let renamed = false;
    const store = new TrustStore("/memory/trust", {
      readFile: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      open: async (path) => ({
        writeFile: async () => undefined,
        sync: async () => { if (path.endsWith(".tmp")) controller.abort(); },
        close: async () => undefined
      }),
      rename: async () => { renamed = true; },
      unlink: async () => undefined
    });

    await expect(store.remember(identity, describeHostKey(rawHostKey()), controller.signal))
      .rejects.toMatchObject({ code: ErrorCodes.TRUST_STORE_ERROR });
    expect(renamed).toBe(false);
  });
});

describe("StrictHostKeyVerifier", () => {
  it("未知 key 仅在表单确认接受且落盘后通过", async () => {
    const events: string[] = [];
    const confirmation: TrustConfirmation = {
      supportsForm: () => true,
      confirm: async (request) => {
        events.push(`confirm:${request.alias}:${request.host}:${request.port}:${request.algorithm}:${request.fingerprint}`);
        return "accept";
      }
    };
    const store = new TrustStore(await temporaryStorePath());
    const verifier = new StrictHostKeyVerifier(store, confirmation);
    const key = rawHostKey();

    await verifier.verify(
      { alias: identity.alias, host: identity.configuredHost, port: identity.port },
      key
    );
    events.push((await store.lookup(identity)) === undefined ? "missing" : "persisted");

    expect(events).toEqual([
      `confirm:linux-test:127.0.0.1:2222:ssh-ed25519:${describeHostKey(key).fingerprint}`,
      "persisted"
    ]);
  });

  it("相同原始字节直接通过，变化则报告旧/新指纹且不发起确认", async () => {
    const store = new TrustStore(await temporaryStorePath());
    const trusted = describeHostKey(rawHostKey("ssh-ed25519", 3));
    await store.remember(identity, trusted);
    let calls = 0;
    const verifier = new StrictHostKeyVerifier(store, {
      supportsForm: () => true,
      confirm: async () => {
        calls += 1;
        return "accept";
      }
    });

    await expect(verifier.verify(
      { alias: identity.alias, host: identity.configuredHost, port: identity.port },
      trusted.rawKey
    )).resolves.toBeUndefined();

    const changed = describeHostKey(rawHostKey("ssh-ed25519", 4));
    await expect(verifier.verify(
      { alias: identity.alias, host: identity.configuredHost, port: identity.port },
      changed.rawKey
    )).rejects.toMatchObject({
      code: ErrorCodes.HOST_KEY_CHANGED,
      details: { oldFingerprint: trusted.fingerprint, newFingerprint: changed.fingerprint }
    });
    expect(calls).toBe(0);
  });

  it("拒绝、取消、不支持和 120000ms 超时均关闭失败且不写信任", async () => {
    const path = await temporaryStorePath();
    const store = new TrustStore(path);
    const timers: Array<() => void> = [];
    const verifier = new StrictHostKeyVerifier(store, {
      supportsForm: () => true,
      confirm: async (_request, signal) => await new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve("cancel"), { once: true });
      })
    }, {
      setTimeout: (callback, delayMs) => {
        expect(delayMs).toBe(HOST_CONFIRMATION_TIMEOUT_MS);
        timers.push(callback);
        return callback;
      },
      clearTimeout: () => undefined
    });

    const pending = verifier.verify(
      { alias: identity.alias, host: identity.configuredHost, port: identity.port },
      rawHostKey()
    );
    while (timers.length === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    timers[0]?.();
    await expect(pending).rejects.toMatchObject({ code: ErrorCodes.HOST_KEY_REJECTED });
    await expect(store.lookup(identity)).resolves.toBeUndefined();

    for (const result of ["decline", "cancel"] as const) {
      await expect(new StrictHostKeyVerifier(store, {
        supportsForm: () => true,
        confirm: async () => result
      }).verify({ alias: identity.alias, host: identity.configuredHost, port: identity.port }, rawHostKey()))
        .rejects.toMatchObject({ code: ErrorCodes.HOST_KEY_REJECTED });
    }

    await expect(new StrictHostKeyVerifier(store, {
      supportsForm: () => false,
      confirm: async () => "accept"
    }).verify({ alias: identity.alias, host: identity.configuredHost, port: identity.port }, rawHostKey()))
      .rejects.toMatchObject({ code: ErrorCodes.HOST_KEY_REJECTED });
  });

  it("确认 Promise 忽略 AbortSignal 时，120000ms 后仍强制拒绝", async () => {
    const timers: Array<() => void> = [];
    const verifier = new StrictHostKeyVerifier(new TrustStore(await temporaryStorePath()), {
      supportsForm: () => true,
      confirm: async () => await new Promise<"accept">(() => undefined)
    }, {
      setTimeout: (callback) => {
        timers.push(callback);
        return callback;
      },
      clearTimeout: () => undefined
    });

    const pending = verifier.verify(
      { alias: identity.alias, host: identity.configuredHost, port: identity.port },
      rawHostKey()
    );
    while (timers.length === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    timers[0]?.();

    const settled = await Promise.race([
      pending.then(() => true, () => true),
      new Promise<boolean>((resolve) => setImmediate(() => resolve(false)))
    ]);
    expect(settled).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: ErrorCodes.HOST_KEY_REJECTED });
  });

  it("连接生命周期取消后不等待确认完成，也不会晚到持久化", async () => {
    let accept: (() => void) | undefined;
    const store = new TrustStore(await temporaryStorePath());
    const verifier = new StrictHostKeyVerifier(store, {
      supportsForm: () => true,
      confirm: async () => await new Promise<"accept">((resolve) => {
        accept = () => resolve("accept");
      })
    });
    const controller = new AbortController();
    const key = rawHostKey();
    const pending = verifier.verify(
      { alias: identity.alias, host: identity.configuredHost, port: identity.port },
      key,
      controller.signal
    );
    while (accept === undefined) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: ErrorCodes.HOST_KEY_REJECTED });
    accept();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(store.lookup(identity)).resolves.toBeUndefined();
  });

  it("lookup 等待期间连接取消后不检查表单，也不发起确认", async () => {
    let finishLookup: (() => void) | undefined;
    let supportsFormCalls = 0;
    let confirmationCalls = 0;
    const verifier = new StrictHostKeyVerifier({
      lookup: async () => await new Promise<void>((resolve) => { finishLookup = resolve; }),
      remember: async () => undefined
    } as unknown as TrustStore, {
      supportsForm: () => {
        supportsFormCalls += 1;
        return true;
      },
      confirm: async () => {
        confirmationCalls += 1;
        return "accept";
      }
    });
    const controller = new AbortController();
    const pending = verifier.verify(
      { alias: identity.alias, host: identity.configuredHost, port: identity.port },
      rawHostKey(),
      controller.signal
    );
    while (finishLookup === undefined) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    controller.abort();
    finishLookup();

    await expect(pending).rejects.toMatchObject({ code: ErrorCodes.HOST_KEY_REJECTED });
    expect(supportsFormCalls).toBe(0);
    expect(confirmationCalls).toBe(0);
  });
});

describe("TrustStore 锁释放", () => {
  it("同 key 持锁重读后，close 失败仍尝试 unlink 并关闭失败", async () => {
    const key = describeHostKey(rawHostKey());
    let unlinked = false;
    const store = new TrustStore("/memory/trust", {
      readFile: async () => JSON.stringify({
        version: 1,
        hosts: {
          "linux-test|127.0.0.1|2222": {
            algorithm: key.algorithm,
            fingerprint: key.fingerprint,
            publicKeyBase64: key.rawKey.toString("base64"),
            confirmedAt: "2026-07-18T01:02:03.000Z"
          }
        }
      }),
      open: async () => ({
        writeFile: async () => undefined,
        sync: async () => undefined,
        close: async () => { throw new Error("close failed"); }
      }),
      rename: async () => undefined,
      unlink: async () => { unlinked = true; }
    });

    await expect(store.remember(identity, key)).rejects.toMatchObject({ code: ErrorCodes.TRUST_STORE_ERROR });
    expect(unlinked).toBe(true);
  });

  it("持锁重读同 key 时不调用 Buffer.equals", async () => {
    const key = describeHostKey(rawHostKey());
    const originalEquals = Buffer.prototype.equals;
    Buffer.prototype.equals = () => { throw new Error("不允许使用非恒定时间比较"); };
    try {
      const store = new TrustStore("/memory/trust", {
        readFile: async () => JSON.stringify({
          version: 1,
          hosts: {
            "linux-test|127.0.0.1|2222": {
              algorithm: key.algorithm,
              fingerprint: key.fingerprint,
              publicKeyBase64: key.rawKey.toString("base64"),
              confirmedAt: "2026-07-18T01:02:03.000Z"
            }
          }
        }),
        open: async () => ({ writeFile: async () => undefined, sync: async () => undefined, close: async () => undefined }),
        rename: async () => undefined,
        unlink: async () => undefined
      });

      await expect(store.remember(identity, key)).resolves.toBeUndefined();
    } finally {
      Buffer.prototype.equals = originalEquals;
    }
  });
});
