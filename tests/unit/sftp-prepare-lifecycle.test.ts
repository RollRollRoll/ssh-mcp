import type { PathLike } from "node:fs";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { HostConfig } from "../../src/config/schema.js";
import { OperationManager } from "../../src/operations/operation-manager.js";
import type { SftpTransferSession, SshConnection } from "../../src/ssh/ssh-adapter.js";
import { TransferService } from "../../src/transfers/file-transfer.js";
import { SftpTransferBackend } from "../../src/transfers/sftp-transfer-backend.js";

const { controlledOpen } = vi.hoisted(() => ({
  controlledOpen: {
    hook: undefined as undefined | ((target: string, handle: Awaited<ReturnType<typeof import("node:fs/promises")["open"]>>) => Promise<Awaited<ReturnType<typeof import("node:fs/promises")["open"]>>>),
    unlinkHook: undefined as undefined | ((target: string) => Promise<void> | undefined)
  }
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (target: PathLike, ...args: unknown[]) => {
      const handle = await Reflect.apply(actual.open, actual, [target, ...args]) as Awaited<ReturnType<typeof actual.open>>;
      return await controlledOpen.hook?.(String(target), handle) ?? handle;
    },
    unlink: async (target: PathLike) => await controlledOpen.unlinkHook?.(String(target)) ?? await actual.unlink(target)
  };
});

const host: HostConfig = {
  alias: "linux", environment: "test", platform: "linux", host: "127.0.0.1", port: 22,
  username: "tester", auth: { type: "privateKeyFile", path: "/tmp/key" },
  shell: { type: "posix", command: "/bin/sh" }, remoteRoots: ["/safe"]
};

describe("SFTP prepare 阶段资源所有权", () => {
  it("远端 writer 创建后重复取消时，挂起 destroy 仍有界关闭本地源、SFTP 与 SSH", async () => {
    const localRoot = await mkdtemp(join(await realpath(tmpdir()), "ssh-mcp-prepare-upload-"));
    const source = join(localRoot, "source.bin");
    await writeFile(source, "data");
    const events: string[] = [];
    const unhandled: unknown[] = [];
    let rejectLateDestroy: ((error: Error) => void) | undefined;
    let started!: ReturnType<TransferService["start"]>;
    controlledOpen.hook = async (target, handle) => target === source
      ? proxyHandle(handle, async () => { events.push("source-close"); await handle.close(); })
      : handle;
    const listener = (error: unknown): void => { unhandled.push(error); };
    process.on("unhandledRejection", listener);
    try {
      const { connection } = connectionFixture(events, {
        createWriteStream: () => {
          manager.cancel(started.operationId);
          manager.cancel(started.operationId);
          return new Writable({
            destroy: (_error, callback) => {
              events.push("writer-destroy");
              rejectLateDestroy = (error) => callback(error);
            }
          });
        }
      });
      const manager = new OperationManager({
        idFactory: () => "prepare-upload-cancel",
        limits: { transferTimeoutMs: 10_000, cancelConfirmationTimeoutMs: 300 }
      });
      const service = new TransferService(manager, new SftpTransferBackend(
        { connect: async () => connection }, [localRoot], {
          localPlatform: "posix", temporaryIdFactory: () => "fixed", cleanupTimeoutMs: 20
        }
      ));

      started = service.start({
        direction: "upload", host, source, target: "/safe/target.bin", overwrite: false, recursive: false
      });
      await terminal(manager, started.operationId);

      expect(manager.get(started.operationId)).toMatchObject({
        state: "unknown",
        error: { code: "STATE_UNKNOWN", sideEffects: "possible" },
        result: { temporaryCleanup: "unknown" }
      });
      expect(events).toEqual(expect.arrayContaining(["writer-destroy", "source-close", "sftp-close", "ssh-close"]));
      expect(events.indexOf("source-close")).toBeGreaterThan(events.indexOf("writer-destroy"));
      expect(events.indexOf("sftp-close")).toBeGreaterThan(events.indexOf("source-close"));
      expect(events.indexOf("ssh-close")).toBeGreaterThan(events.indexOf("sftp-close"));
      expect(events.filter((event) => event === "source-close")).toHaveLength(1);
      expect(events.filter((event) => event === "sftp-close")).toHaveLength(1);
      expect(events.filter((event) => event === "ssh-close")).toHaveLength(1);

      rejectLateDestroy?.(new Error("late writer rejection"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(events.filter((event) => event === "unlink")).toHaveLength(0);
    } finally {
      controlledOpen.hook = undefined;
      controlledOpen.unlinkHook = undefined;
      process.removeListener("unhandledRejection", listener);
    }
  });

  it("本地 openExclusive 已创建目标后超时，挂起且迟到拒绝的 handle close 不阻止远端 handle、SFTP 与 SSH", async () => {
    const localRoot = await mkdtemp(join(await realpath(tmpdir()), "ssh-mcp-prepare-download-"));
    const target = join(localRoot, "target.bin");
    const events: string[] = [];
    const unhandled: unknown[] = [];
    let rejectLateUnlink: ((error: Error) => void) | undefined;
    let remoteHandleCloses = 0;
    controlledOpen.hook = async (openedPath, handle) => {
      if (!openedPath.endsWith(".ssh-mcp-fixed.part")) return handle;
      events.push("local-target-open");
      await new Promise((resolve) => setTimeout(resolve, 30));
      return proxyHandle(handle, async () => {
        events.push("local-target-close");
        await handle.close();
      });
    };
    controlledOpen.unlinkHook = (openedPath) => openedPath.endsWith(".ssh-mcp-fixed.part")
      ? new Promise<never>((_resolve, reject) => {
        events.push("unlink");
        rejectLateUnlink = reject;
      })
      : undefined;
    const listener = (error: unknown): void => { unhandled.push(error); };
    process.on("unhandledRejection", listener);
    try {
      const { connection } = connectionFixture(events, {
        openReadFile: async () => ({
          stream: Readable.from([Buffer.from("data")]),
          stat: { kind: "file", id: "source", size: 4 },
          close: async () => { remoteHandleCloses += 1; events.push("remote-handle-close"); }
        })
      });
      const manager = new OperationManager({
        idFactory: () => "prepare-download-timeout",
        limits: { transferTimeoutMs: 5, cancelConfirmationTimeoutMs: 300 }
      });
      const service = new TransferService(manager, new SftpTransferBackend(
        { connect: async () => connection }, [localRoot], {
          localPlatform: "posix", temporaryIdFactory: () => "fixed", cleanupTimeoutMs: 20
        }
      ));
      const started = service.start({
        direction: "download", host, source: "/safe/source.bin", target, overwrite: false, recursive: false,
        expectedSourceIdentity: { kind: "file", id: "source", size: 4 }
      });
      await terminal(manager, started.operationId);

      expect(manager.get(started.operationId)).toMatchObject({
        state: "unknown",
        error: { code: "STATE_UNKNOWN", sideEffects: "possible" },
        result: { temporaryCleanup: "unknown" }
      });
      expect(events.indexOf("local-target-close")).toBeGreaterThan(events.indexOf("local-target-open"));
      expect(events.indexOf("unlink")).toBeGreaterThan(events.indexOf("local-target-close"));
      expect(events.indexOf("remote-handle-close")).toBeGreaterThan(events.indexOf("unlink"));
      expect(events.indexOf("sftp-close")).toBeGreaterThan(events.indexOf("remote-handle-close"));
      expect(events.indexOf("ssh-close")).toBeGreaterThan(events.indexOf("sftp-close"));
      expect(remoteHandleCloses).toBe(1);
      expect(events.filter((event) => event === "sftp-close")).toHaveLength(1);
      expect(events.filter((event) => event === "ssh-close")).toHaveLength(1);

      rejectLateUnlink?.(new Error("late unlink rejection"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      controlledOpen.hook = undefined;
      controlledOpen.unlinkHook = undefined;
      process.removeListener("unhandledRejection", listener);
    }
  });
});

function connectionFixture(
  events: string[],
  overrides: Partial<Pick<SftpTransferSession, "createWriteStream" | "openReadFile">>
): { connection: SshConnection; sftp: SftpTransferSession } {
  const missing = (): Error => Object.assign(new Error("missing"), { code: "ENOENT" });
  const sftp: SftpTransferSession = {
    lstat: async (target) => {
      if (target === "/") return { kind: "directory", id: "root", size: 0 };
      if (target === "/safe") return { kind: "directory", id: "safe", size: 0 };
      if (target === "/safe/source.bin") return { kind: "file", id: "source", size: 4 };
      throw missing();
    },
    realpath: async (target) => target,
    createReadStream: () => { throw new Error("测试必须使用 opened file"); },
    ...(overrides.openReadFile === undefined ? {} : { openReadFile: overrides.openReadFile }),
    createWriteStream: overrides.createWriteStream ?? (() => { throw new Error("不应创建远端目标"); }),
    supportsAtomicReplace: true,
    supportsHardlink: true,
    atomicReplace: async () => undefined,
    hardlink: async () => undefined,
    unlink: async () => { events.push("unlink"); },
    close: () => { events.push("sftp-close"); }
  };
  return {
    sftp,
    connection: {
      exec: () => undefined,
      openShell: () => undefined,
      openSftp: (callback) => callback(undefined, sftp),
      close: () => { events.push("ssh-close"); }
    }
  };
}

function proxyHandle<T extends Awaited<ReturnType<typeof import("node:fs/promises")["open"]>>>(
  handle: T,
  close: () => Promise<void>
): T {
  return new Proxy(handle, {
    get: (target, property) => {
      if (property === "close") return close;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

async function terminal(manager: OperationManager, operationId: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (["completed", "failed", "cancelled", "timed_out", "partial_failure", "unknown"].includes(manager.get(operationId).state)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("操作未在期限内终结");
}
