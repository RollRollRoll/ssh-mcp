import { PassThrough, Readable } from "node:stream";
import { join } from "node:path";
import { lstat, mkdtemp, open, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { TransferService, type PreparedTransfer, type TransferBackend } from "../../src/transfers/file-transfer.js";
import { OperationManager, OperationManagerError } from "../../src/operations/operation-manager.js";
import type { HostConfig } from "../../src/config/schema.js";
import { ErrorCodes } from "../../src/errors/error-codes.js";
import { AtomicTarget, type AtomicTargetPort, type TemporaryWriter } from "../../src/transfers/atomic-target.js";
import { SftpTransferBackend } from "../../src/transfers/sftp-transfer-backend.js";
import type { SftpTransferSession, SshConnection } from "../../src/ssh/ssh-adapter.js";

const host: HostConfig = {
  alias: "linux", environment: "test", platform: "linux", host: "127.0.0.1", port: 22,
  username: "tester", auth: { type: "privateKeyFile", path: "/tmp/key" },
  shell: { type: "posix", command: "/bin/sh" }, remoteRoots: ["/safe"]
};

describe("TransferService 单文件生命周期", () => {
  it("生产后端的 openSftp callback 挂起时，超时会有界关闭连接且只关闭一次", async () => {
    let closes = 0;
    const manager = new OperationManager({
      idFactory: () => "hung-open-sftp",
      limits: { transferTimeoutMs: 5, cancelConfirmationTimeoutMs: 50 }
    });
    const service = new TransferService(manager, new SftpTransferBackend({
      connect: async () => ({
        exec: () => undefined,
        openShell: () => undefined,
        openSftp: () => undefined,
        close: () => { closes += 1; }
      })
    }, ["/local"], { localPlatform: "posix" }));

    const started = service.start({
      direction: "download", host, source: "/safe/source", target: "/local/target", overwrite: false
    });
    await terminal(manager, started.operationId);

    expect(manager.get(started.operationId)).toMatchObject({ state: "timed_out" });
    expect(closes).toBe(1);
  });

  it("按原始字节流传输并把真实进度写入 operation_get，校验后才提交", async () => {
    const target = new PassThrough();
    const received: Buffer[] = [];
    target.on("data", (chunk: Buffer) => received.push(Buffer.from(chunk)));
    let committed = 0;
    const manager = new OperationManager({ idFactory: () => "upload-1" });
    const progress: unknown[] = [];
    const service = new TransferService(manager, backend({
      source: Readable.from([Buffer.from([0, 255, 13, 10]), Buffer.from("中文")]),
      target,
      totalBytes: 10,
      commit: async () => { committed += 1; }
    }), (event) => progress.push(event));

    const started = service.start({ direction: "upload", host, source: "/local/data.bin", target: "/safe/data.bin", overwrite: false });
    expect(started).toMatchObject({ operationId: "upload-1", state: "running" });
    await terminal(manager, started.operationId);

    expect(Buffer.concat(received)).toEqual(Buffer.concat([Buffer.from([0, 255, 13, 10]), Buffer.from("中文")]));
    expect(committed).toBe(1);
    expect(manager.get(started.operationId)).toMatchObject({
      state: "completed",
      result: {
        direction: "upload", host: "linux", source: "/local/data.bin", target: "/safe/data.bin",
        transferredBytes: 10, totalBytes: 10, completedItems: 1, temporaryCleanup: "not_needed"
      }
    });
    expect(progress).toEqual(expect.arrayContaining([
      { operationId: "upload-1", host: "linux", transferredBytes: 0, totalBytes: 10, completedItems: 0 },
      { operationId: "upload-1", host: "linux", transferredBytes: 10, totalBytes: 10, completedItems: 0 }
    ]));
  });

  it("源大小与实际字节不一致时不提交并清理临时目标", async () => {
    let committed = 0;
    let cleaned = 0;
    const manager = new OperationManager({ idFactory: () => "mismatch" });
    const service = new TransferService(manager, backend({
      source: Readable.from([Buffer.from("short")]), target: new PassThrough(), totalBytes: 99,
      commit: async () => { committed += 1; }, cleanup: async () => { cleaned += 1; return true; }
    }));
    const started = service.start({ direction: "download", host, source: "/safe/source", target: "/local/target", overwrite: true });
    await terminal(manager, started.operationId);
    expect(committed).toBe(0);
    expect(cleaned).toBe(1);
    expect(manager.get(started.operationId)).toMatchObject({
      state: "failed", error: { code: "TRANSFER_FAILED", sideEffects: "none" },
      result: { transferredBytes: 5, totalBytes: 99, completedItems: 0, temporaryCleanup: "removed" }
    });
  });

  it("取消销毁流并确认临时文件清理后才标记 cancelled", async () => {
    const source = new PassThrough();
    const target = new PassThrough();
    let cleaned = 0;
    const manager = new OperationManager({ idFactory: () => "cancelled" });
    const service = new TransferService(manager, backend({
      source, target, totalBytes: 100,
      commit: async () => undefined,
      cleanup: async () => { cleaned += 1; return true; }
    }));
    const started = service.start({ direction: "upload", host, source: "/local/source", target: "/safe/target", overwrite: false });
    source.write(Buffer.from("started"));
    await waitUntil(() => (manager.get(started.operationId).result?.transferredBytes as number | undefined) === 7);
    expect(manager.cancel(started.operationId).state).toBe("running");
    await terminal(manager, started.operationId);
    expect(cleaned).toBe(1);
    expect(source.destroyed).toBe(true);
    expect(target.destroyed).toBe(true);
    expect(manager.get(started.operationId)).toMatchObject({ state: "cancelled", result: { temporaryCleanup: "removed" } });
  });

  it("失败和取消都在关闭 SFTP/连接之前清理远端临时文件", async () => {
    let closed = false;
    let cleanupSawOpenConnection = false;
    const manager = new OperationManager({ idFactory: () => "cleanup-order" });
    const service = new TransferService(manager, backend({
      source: Readable.from([Buffer.from("short")]), target: new PassThrough(), totalBytes: 10,
      commit: async () => undefined,
      cleanup: async () => { cleanupSawOpenConnection = !closed; return true; },
      close: async () => { closed = true; }
    }));
    const started = service.start({ direction: "upload", host, source: "/local/source", target: "/safe/target", overwrite: false });
    await terminal(manager, started.operationId);
    expect(cleanupSawOpenConnection).toBe(true);
    expect(closed).toBe(true);
  });

  it("最终目标已完整提交但临时文件删除失败时返回 partial_failure 和明确副作用", async () => {
    const manager = new OperationManager({ idFactory: () => "cleanup-failed" });
    const service = new TransferService(manager, backend({
      source: Readable.from([Buffer.from("done")]), target: new PassThrough(), totalBytes: 4,
      commit: async () => "failed"
    }));
    const started = service.start({ direction: "upload", host, source: "/local/source", target: "/safe/target", overwrite: false });
    await terminal(manager, started.operationId);
    expect(manager.get(started.operationId)).toMatchObject({
      state: "partial_failure",
      error: { code: "PARTIAL_FAILURE", finalState: "partial_failure", sideEffects: "partial", details: { temporaryCleanup: "failed" } },
      result: { completedItems: 1, transferredBytes: 4, temporaryCleanup: "failed" }
    });
  });

  it("取消会中止尚在 prepare 的后端，且不继续创建目标 I/O", async () => {
    let observedAbort = false;
    const manager = new OperationManager({ idFactory: () => "prepare-cancel" });
    const service = new TransferService(manager, {
      prepare: async (_request, signal) => await new Promise<never>((_resolve, reject) => {
        const stop = (): void => { observedAbort = true; reject(new Error("aborted")); };
        if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
      })
    });
    const started = service.start({ direction: "download", host, source: "/safe/source", target: "/local/target", overwrite: false });
    manager.cancel(started.operationId);
    await terminal(manager, started.operationId);
    expect(observedAbort).toBe(true);
    expect(manager.get(started.operationId)).toMatchObject({ state: "cancelled", result: { transferredBytes: 0, temporaryCleanup: "not_needed" } });
  });

  it("取消后无法确认临时文件清理时收敛为 unknown，而不是 cancelled", async () => {
    const source = new PassThrough();
    const manager = new OperationManager({ idFactory: () => "cleanup-unknown" });
    const service = new TransferService(manager, backend({
      source, target: new PassThrough(), totalBytes: 20, commit: async () => undefined,
      cleanup: async () => false
    }));
    const started = service.start({ direction: "upload", host, source: "/local/source", target: "/safe/target", overwrite: false });
    source.write(Buffer.from("x"));
    await waitUntil(() => Number(manager.get(started.operationId).result?.transferredBytes ?? 0) === 1);
    manager.cancel(started.operationId);
    await terminal(manager, started.operationId);
    expect(manager.get(started.operationId)).toMatchObject({
      state: "unknown", error: { code: "STATE_UNKNOWN", sideEffects: "possible", details: { temporaryCleanup: "failed" } },
      result: { temporaryCleanup: "failed", completedItems: 0 }
    });
  });

  it("30 分钟传输预算使用 transfer timeout，并在确认清理后标记 timed_out", async () => {
    const manager = new OperationManager({ idFactory: () => "transfer-timeout", limits: { transferTimeoutMs: 10 } });
    const service = new TransferService(manager, backend({
      source: new PassThrough(), target: new PassThrough(), totalBytes: 20, commit: async () => undefined,
      cleanup: async () => true
    }));
    const started = service.start({ direction: "download", host, source: "/safe/source", target: "/local/target", overwrite: false });
    await terminal(manager, started.operationId);
    expect(manager.get(started.operationId)).toMatchObject({
      state: "timed_out", error: { code: "TRANSFER_TIMEOUT", finalState: "timed_out", sideEffects: "none" },
      result: { temporaryCleanup: "removed", completedItems: 0 }
    });
  });

  it("取消确认超时发生在 prepare 期间时，迟到资源仍会清理并 close-once", async () => {
    let cleaned = 0;
    let closed = 0;
    let release!: () => void;
    const manager = new OperationManager({ idFactory: () => "late-prepare", limits: { cancelConfirmationTimeoutMs: 10 } });
    const service = new TransferService(manager, {
      prepare: async () => {
        await new Promise<void>((resolve) => { release = resolve; });
        return {
          source: Readable.from([Buffer.from("late")]), target: new PassThrough(), totalBytes: 4,
          seal: async () => undefined,
          commit: async () => undefined,
          cleanup: async () => { cleaned += 1; return true; },
          close: async () => { closed += 1; }
        };
      }
    });
    const started = service.start({ direction: "upload", host, source: "/local/source", target: "/safe/target", overwrite: false });
    await new Promise<void>((resolve) => setImmediate(resolve));
    manager.cancel(started.operationId);
    await terminal(manager, started.operationId);
    expect(manager.get(started.operationId).state).toBe("unknown");
    release();
    await waitUntil(() => closed === 1);
    expect(cleaned).toBe(1);
    expect(closed).toBe(1);
  });

  it("seal 前和 seal 中取消都阻止提交并在清理确认后收敛", async () => {
    for (const point of ["before-seal", "during-seal"] as const) {
      let commits = 0;
      let releaseSeal!: () => void;
      let sealStarted = false;
      const source = point === "before-seal" ? new PassThrough() : Readable.from([Buffer.from("done")]);
      const manager = new OperationManager({ idFactory: () => `cancel-${point}` });
      const service = new TransferService(manager, backend({
        source, target: new PassThrough(), totalBytes: 4,
        seal: async () => {
          sealStarted = true;
          if (point === "during-seal") await new Promise<void>((resolve) => { releaseSeal = resolve; });
        },
        commit: async () => { commits += 1; }, cleanup: async () => true
      }));
      const started = service.start({ direction: "upload", host, source: "/local/source", target: "/safe/target", overwrite: false });
      if (point === "before-seal") {
        source.write(Buffer.from("done"));
        await waitUntil(() => Number(manager.get(started.operationId).result?.transferredBytes ?? 0) === 4);
      } else {
        await waitUntil(() => sealStarted);
      }
      manager.cancel(started.operationId);
      releaseSeal?.();
      await terminal(manager, started.operationId);
      expect(commits).toBe(0);
      expect(manager.get(started.operationId)).toMatchObject({
        state: "cancelled", result: { finalTargetCommit: "not_committed", stopRequested: true, stopReason: "cancel" }
      });
    }
  });

  it("commit 已开始或已完成后的取消不伪造 cancelled，并记录最终落地证据", async () => {
    for (const point of ["during-commit", "after-commit"] as const) {
      let releaseCommit!: () => void;
      let commitStarted = false;
      let commitFinished = false;
      let releaseClose!: () => void;
      const manager = new OperationManager({ idFactory: () => point });
      const service = new TransferService(manager, backend({
        source: Readable.from([Buffer.from("done")]), target: new PassThrough(), totalBytes: 4,
        commit: async () => {
          commitStarted = true;
          if (point === "during-commit") await new Promise<void>((resolve) => { releaseCommit = resolve; });
          commitFinished = true;
        },
        close: async () => {
          if (point === "after-commit") await new Promise<void>((resolve) => { releaseClose = resolve; });
        }
      }));
      const started = service.start({ direction: "upload", host, source: "/local/source", target: "/safe/target", overwrite: false });
      await waitUntil(() => point === "during-commit" ? commitStarted : commitFinished);
      manager.cancel(started.operationId);
      releaseCommit?.();
      releaseClose?.();
      await terminal(manager, started.operationId);
      expect(manager.get(started.operationId)).toMatchObject({
        state: "completed",
        result: { completedItems: 1, finalTargetCommit: "committed", stopRequested: true, stopReason: "cancel" }
      });
    }
  });

  it("commit 进行中的超时按最终提交证据完成，不伪造 timed_out", async () => {
    let releaseCommit!: () => void;
    let commitStarted = false;
    const manager = new OperationManager({ idFactory: () => "commit-timeout", limits: { transferTimeoutMs: 10 } });
    const service = new TransferService(manager, backend({
      source: Readable.from([Buffer.from("done")]), target: new PassThrough(), totalBytes: 4,
      commit: async () => { commitStarted = true; await new Promise<void>((resolve) => { releaseCommit = resolve; }); }
    }));
    const started = service.start({ direction: "upload", host, source: "/local/source", target: "/safe/target", overwrite: false });
    await waitUntil(() => commitStarted);
    await new Promise((resolve) => setTimeout(resolve, 15));
    releaseCommit();
    await terminal(manager, started.operationId);
    expect(manager.get(started.operationId)).toMatchObject({
      state: "completed", result: { finalTargetCommit: "committed", stopRequested: true, stopReason: "timeout" }
    });
  });

  it("最终目标已提交后关闭失败返回 completedItems=1 与明确副作用", async () => {
    const manager = new OperationManager({ idFactory: () => "post-commit-close" });
    const service = new TransferService(manager, backend({
      source: Readable.from([Buffer.from("done")]), target: new PassThrough(), totalBytes: 4,
      commit: async () => undefined, close: async () => { throw new Error("close boom"); }
    }));
    const started = service.start({ direction: "upload", host, source: "/local/source", target: "/safe/target", overwrite: false });
    await terminal(manager, started.operationId);
    expect(manager.get(started.operationId)).toMatchObject({
      state: "partial_failure",
      error: { code: "PARTIAL_FAILURE", sideEffects: "confirmed" },
      result: { completedItems: 1, finalTargetCommit: "committed" }
    });
  });

  it("commit 响应丢失时最终目标证据保持 unknown，不输出布尔否定", async () => {
    const manager = new OperationManager({ idFactory: () => "commit-reply-lost" });
    const service = new TransferService(manager, backend({
      source: Readable.from([Buffer.from("x")]), target: new PassThrough(), totalBytes: 1,
      commit: async () => { throw new Error("reply lost"); }
    }));
    const started = service.start({ direction: "upload", host, source: "/local/source", target: "/safe/target", overwrite: false });
    await terminal(manager, started.operationId);
    const snapshot = manager.get(started.operationId);
    expect(snapshot).toMatchObject({
      state: "unknown",
      error: { code: "STATE_UNKNOWN", sideEffects: "possible", details: { commitOutcome: "unknown" } },
      result: { finalTargetCommit: "unknown", completedItems: 0 }
    });
    expect(snapshot.result).not.toHaveProperty("finalTargetCommitted");
  });

  it("unknown 过期后迟到 prepare 仍清理并 close-once，且不产生未处理拒绝", async () => {
    let releasePrepare!: () => void;
    let cleaned = 0;
    let closed = 0;
    const unhandled: unknown[] = [];
    const listener = (error: unknown): void => { unhandled.push(error); };
    process.on("unhandledRejection", listener);
    try {
      const manager = new OperationManager({
        idFactory: () => "expired-late-prepare",
        limits: { cancelConfirmationTimeoutMs: 5, resultRetentionMs: 5 }
      });
      const service = new TransferService(manager, {
        prepare: async () => {
          await new Promise<void>((resolve) => { releasePrepare = resolve; });
          return {
            source: Readable.from([Buffer.from("late")]), target: new PassThrough(), totalBytes: 4,
            seal: async () => undefined, commit: async () => undefined,
            cleanup: async () => { cleaned += 1; return true; },
            close: async () => { closed += 1; }
          };
        }
      });
      const started = service.start({ direction: "upload", host, source: "/local/source", target: "/safe/target", overwrite: false });
      await new Promise<void>((resolve) => setImmediate(resolve));
      manager.cancel(started.operationId);
      await waitUntil(() => manager.get(started.operationId).state === "unknown");
      expect(manager.get(started.operationId).result).toMatchObject({ finalTargetCommit: "not_committed" });
      await waitUntilExpired(manager, started.operationId);
      releasePrepare();
      await waitUntil(() => closed === 1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(cleaned).toBe(1);
      expect(closed).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", listener);
    }
  });

  it("unknown 过期后迟到 commit 不覆写终态，仍 close-once 且无未处理拒绝", async () => {
    let releaseCommit!: () => void;
    let commitStarted = false;
    let cleaned = 0;
    let closed = 0;
    const unhandled: unknown[] = [];
    const listener = (error: unknown): void => { unhandled.push(error); };
    process.on("unhandledRejection", listener);
    try {
      const manager = new OperationManager({
        idFactory: () => "expired-late-commit",
        limits: { cancelConfirmationTimeoutMs: 5, resultRetentionMs: 5 }
      });
      const service = new TransferService(manager, backend({
        source: Readable.from([Buffer.from("done")]), target: new PassThrough(), totalBytes: 4,
        commit: async () => {
          commitStarted = true;
          await new Promise<void>((resolve) => { releaseCommit = resolve; });
          throw new Error("reply lost");
        },
        cleanup: async () => { cleaned += 1; return true; },
        close: async () => { closed += 1; }
      }));
      const started = service.start({ direction: "upload", host, source: "/local/source", target: "/safe/target", overwrite: false });
      await waitUntil(() => commitStarted);
      manager.cancel(started.operationId);
      await waitUntil(() => manager.get(started.operationId).state === "unknown");
      const frozen = manager.get(started.operationId);
      expect(frozen.result).toMatchObject({ finalTargetCommit: "unknown" });
      expect(frozen.result).not.toHaveProperty("finalTargetCommitted");
      await waitUntilExpired(manager, started.operationId);
      releaseCommit();
      await waitUntil(() => closed === 1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(cleaned).toBe(1);
      expect(closed).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", listener);
    }
  });

  it("强制停止不会产生未处理 Promise rejection", async () => {
    let release!: () => void;
    const unhandled: unknown[] = [];
    const listener = (error: unknown): void => { unhandled.push(error); };
    process.on("unhandledRejection", listener);
    try {
      const manager = new OperationManager({ idFactory: () => "force-stop", limits: { cancelConfirmationTimeoutMs: 10 } });
      const service = new TransferService(manager, backend({
        source: new PassThrough(), target: new PassThrough(), totalBytes: 4,
        commit: async () => undefined,
        cleanup: async () => await new Promise<boolean>((resolve) => { release = () => resolve(false); }),
        close: async () => { throw new Error("close boom"); }
      }));
      const started = service.start({ direction: "upload", host, source: "/local/source", target: "/safe/target", overwrite: false });
      manager.cancel(started.operationId);
      await terminal(manager, started.operationId);
      release?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", listener);
    }
  });

  it("recursive=false 的本地目录源在创建远端 part 前拒绝", async () => {
    const opened: string[] = [];
    let cleanupAttempts = 0;
    let sftpCloses = 0;
    let connectionCloses = 0;
    const notFound = (): Error => Object.assign(new Error("missing"), { code: "ENOENT" });
    const sftp: SftpTransferSession = {
      lstat: async (target) => {
        if (target === "/") return { kind: "directory", id: "root-1", size: 0 };
        if (target === "/safe") return { kind: "directory", id: "safe-1", size: 0 };
        throw notFound();
      },
      realpath: async (target) => target,
      createReadStream: () => { throw new Error("不应读取远端源"); },
      createWriteStream: (target) => { opened.push(target); return new PassThrough(); },
      supportsAtomicReplace: true,
      supportsHardlink: true,
      atomicReplace: async () => undefined,
      hardlink: async () => undefined,
      unlink: async () => { cleanupAttempts += 1; throw Object.assign(new Error("denied"), { code: "EACCES" }); },
      close: () => { sftpCloses += 1; }
    };
    const connection: SshConnection = {
      exec: () => undefined,
      openShell: () => undefined,
      openSftp: (callback) => callback(undefined, sftp),
      close: () => { connectionCloses += 1; }
    };
    const manager = new OperationManager({ idFactory: () => "prepare-cleanup-failed" });
    const service = new TransferService(manager, new SftpTransferBackend(
      { connect: async () => connection }, [process.cwd()], { localPlatform: "posix", temporaryIdFactory: () => "fixed" }
    ));
    const started = service.start({
      direction: "upload", host, source: join(process.cwd(), ".execute-task"), target: "/safe/target", overwrite: false
    });
    await terminal(manager, started.operationId);
    expect(opened).toEqual([]);
    expect(cleanupAttempts).toBe(0);
    expect(sftpCloses).toBe(1);
    expect(connectionCloses).toBe(1);
    expect(manager.get(started.operationId)).toMatchObject({
      state: "failed",
      error: { code: "PATH_DENIED", sideEffects: "none" },
      result: { completedItems: 0, finalTargetCommit: "not_committed", temporaryCleanup: "not_needed" }
    });
  });

  it("目录枚举身份必须在实际打开后的本地 fstat 再比较，普通文件换身时拒绝且不创建远端目标", async () => {
    const localRoot = await mkdtemp(join(await realpath(tmpdir()), "ssh-mcp-identity-"));
    const source = join(localRoot, "source.bin");
    await writeFile(source, "changed");
    const opened: string[] = [];
    const notFound = (): Error => Object.assign(new Error("missing"), { code: "ENOENT" });
    const sftp: SftpTransferSession = {
      lstat: async (target) => {
        if (target === "/") return { kind: "directory", id: "root", size: 0 };
        if (target === "/safe") return { kind: "directory", id: "safe", size: 0 };
        throw notFound();
      },
      realpath: async (target) => target,
      createReadStream: () => { throw new Error("不应读取远端"); },
      createWriteStream: (target) => { opened.push(target); return new PassThrough(); },
      supportsAtomicReplace: true, supportsHardlink: true,
      atomicReplace: async () => undefined, hardlink: async () => undefined,
      unlink: async () => undefined, close: () => undefined
    };
    const connection: SshConnection = {
      exec: () => undefined, openShell: () => undefined,
      openSftp: (callback) => callback(undefined, sftp), close: () => undefined
    };
    const backend = new SftpTransferBackend({ connect: async () => connection }, [localRoot], { localPlatform: "posix" });
    let caught: unknown;
    try {
      const prepared = await backend.prepare({
        direction: "upload", host, source, target: "/safe/target.bin", overwrite: false, recursive: false,
        expectedSourceIdentity: { kind: "file", id: "different-enumerated-id", size: 7 }
      }, new AbortController().signal);
      await prepared.close();
    } catch (error: unknown) { caught = error; }
    expect(caught).toMatchObject({ code: ErrorCodes.PATH_DENIED });
    expect(opened).toEqual([]);
  });

  it("目录上传在真实本地 fd 打开前后复核挂载证据，后置失败时不创建远端目标并关闭 fd", async () => {
    const localRoot = await mkdtemp(join(await realpath(tmpdir()), "ssh-mcp-mount-open-"));
    const source = join(localRoot, "source.bin");
    await writeFile(source, "safe");
    const sourceStatus = await lstat(source);
    const opened: string[] = [];
    let mountChecks = 0;
    const sftp: SftpTransferSession = {
      lstat: async (target) => {
        if (target === "/") return { kind: "directory", id: "root", size: 0 };
        if (target === "/safe") return { kind: "directory", id: "safe", size: 0 };
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      realpath: async (target) => target,
      createReadStream: () => { throw new Error("不应读取远端"); },
      createWriteStream: (target) => { opened.push(target); return new PassThrough(); },
      supportsAtomicReplace: true, supportsHardlink: true,
      atomicReplace: async () => undefined, hardlink: async () => undefined,
      unlink: async () => undefined, close: () => undefined
    };
    const connection: SshConnection = {
      exec: () => undefined, openShell: () => undefined,
      openSftp: (callback) => callback(undefined, sftp), close: () => undefined
    };
    const backend = new SftpTransferBackend({ connect: async () => connection }, [localRoot], { localPlatform: "posix" });
    await expect(backend.prepare({
      direction: "upload", host, source, target: "/safe/target.bin", overwrite: false, recursive: false,
      expectedSourceIdentity: { kind: "file", id: `${sourceStatus.dev.toString(16)}:${sourceStatus.ino.toString(16)}`, size: 4 },
      sourceMountVerifier: async () => {
        mountChecks += 1;
        if (mountChecks === 2) throw Object.assign(new Error("bind mount appeared"), { code: ErrorCodes.PATH_DENIED });
      }
    }, new AbortController().signal)).rejects.toMatchObject({ code: ErrorCodes.PATH_DENIED });
    expect(mountChecks).toBe(2);
    expect(opened).toEqual([]);
    await expect(open(source, "r").then(async (handle) => { await handle.close(); })).resolves.toBeUndefined();
  });

  it("远端源在枚举复核与实际句柄 fstat 间换身时拒绝且不创建本地目标", async () => {
    const localRoot = await mkdtemp(join(await realpath(tmpdir()), "ssh-mcp-remote-identity-"));
    const target = join(localRoot, "target.bin");
    let openedHandles = 0;
    let closedHandles = 0;
    const sftp: SftpTransferSession = {
      lstat: async (value) => {
        if (value === "/") return { kind: "directory", id: "root", size: 0 };
        if (value === "/safe") return { kind: "directory", id: "safe", size: 0 };
        if (value === "/safe/source.bin") return { kind: "file", id: "enumerated", size: 4 };
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      realpath: async (value) => value,
      createReadStream: () => { throw new Error("必须使用句柄打开接口"); },
      openReadFile: async () => {
        openedHandles += 1;
        return {
          stream: Readable.from([Buffer.from("evil")]), stat: { kind: "file", id: "replacement", size: 4 },
          close: async () => { closedHandles += 1; }
        };
      },
      createWriteStream: () => { throw new Error("不应创建远端目标"); },
      supportsAtomicReplace: true, supportsHardlink: true,
      atomicReplace: async () => undefined, hardlink: async () => undefined,
      unlink: async () => undefined, close: () => undefined
    };
    const connection: SshConnection = {
      exec: () => undefined, openShell: () => undefined,
      openSftp: (callback) => callback(undefined, sftp), close: () => undefined
    };
    const backend = new SftpTransferBackend({ connect: async () => connection }, [localRoot], { localPlatform: "posix" });
    await expect(backend.prepare({
      direction: "download", host, source: "/safe/source.bin", target, overwrite: false, recursive: false,
      expectedSourceIdentity: { kind: "file", id: "enumerated", size: 4 }
    }, new AbortController().signal)).rejects.toMatchObject({ code: ErrorCodes.PATH_DENIED });
    expect(openedHandles).toBe(1);
    expect(closedHandles).toBe(1);
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("目录下载在真实远端 handle 打开前后复核挂载证据，后置失败时 close-once 且不创建本地目标", async () => {
    const localRoot = await mkdtemp(join(await realpath(tmpdir()), "ssh-mcp-remote-mount-open-"));
    const target = join(localRoot, "target.bin");
    let mountChecks = 0;
    let closes = 0;
    const sftp: SftpTransferSession = {
      lstat: async (value) => {
        if (value === "/") return { kind: "directory", id: "root", size: 0 };
        if (value === "/safe") return { kind: "directory", id: "safe", size: 0 };
        if (value === "/safe/source.bin") return { kind: "file", id: "enumerated", size: 4 };
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      realpath: async (value) => value,
      createReadStream: () => { throw new Error("必须使用句柄打开接口"); },
      openReadFile: async () => ({
        stream: Readable.from([Buffer.from("safe")]), stat: { kind: "file", id: "enumerated", size: 4 },
        close: async () => { closes += 1; }
      }),
      createWriteStream: () => { throw new Error("不应创建远端目标"); },
      supportsAtomicReplace: true, supportsHardlink: true,
      atomicReplace: async () => undefined, hardlink: async () => undefined,
      unlink: async () => undefined, close: () => undefined
    };
    const connection: SshConnection = {
      exec: () => undefined, openShell: () => undefined,
      openSftp: (callback) => callback(undefined, sftp), close: () => undefined
    };
    const backend = new SftpTransferBackend({ connect: async () => connection }, [localRoot], { localPlatform: "posix" });
    await expect(backend.prepare({
      direction: "download", host, source: "/safe/source.bin", target, overwrite: false, recursive: false,
      expectedSourceIdentity: { kind: "file", id: "enumerated", size: 4 },
      sourceMountVerifier: async () => {
        mountChecks += 1;
        if (mountChecks === 2) throw Object.assign(new Error("bind mount appeared"), { code: ErrorCodes.PATH_DENIED });
      }
    }, new AbortController().signal)).rejects.toMatchObject({ code: ErrorCodes.PATH_DENIED });
    expect(mountChecks).toBe(2);
    expect(closes).toBe(1);
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("远端 opened file 在非法 stat、目标验证失败时都等待 close-once，关闭失败按未知证据收敛", async () => {
    for (const scenario of ["invalid_stat", "target_guard", "close_failure"] as const) {
      const localRoot = await mkdtemp(join(await realpath(tmpdir()), "ssh-mcp-opened-close-"));
      const target = scenario === "target_guard" ? join(localRoot, "missing", "target.bin") : join(localRoot, "target.bin");
      const source = new PassThrough();
      let closes = 0;
      const unhandled: unknown[] = [];
      const listener = (error: unknown): void => { unhandled.push(error); };
      process.on("unhandledRejection", listener);
      try {
        const sftp: SftpTransferSession = {
          lstat: async (value) => {
            if (value === "/") return { kind: "directory", id: "root", size: 0 };
            if (value === "/safe") return { kind: "directory", id: "safe", size: 0 };
            if (value === "/safe/source.bin") return { kind: "file", id: "enumerated", size: 4 };
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
          },
          realpath: async (value) => value,
          createReadStream: () => { throw new Error("必须使用 opened file"); },
          openReadFile: async () => ({
            stream: source,
            stat: scenario === "invalid_stat"
              ? { kind: "file", id: "enumerated", size: -1 }
              : scenario === "close_failure"
                ? { kind: "file", id: "replacement", size: 4 }
              : { kind: "file", id: "enumerated", size: 4 },
            close: async () => { closes += 1; if (scenario === "close_failure") throw new Error("close failed"); }
          }),
          createWriteStream: () => { throw new Error("不应创建远端目标"); },
          supportsAtomicReplace: true, supportsHardlink: true,
          atomicReplace: async () => undefined, hardlink: async () => undefined,
          unlink: async () => undefined, close: () => undefined
        };
        const connection: SshConnection = {
          exec: () => undefined, openShell: () => undefined,
          openSftp: (callback) => callback(undefined, sftp), close: () => undefined
        };
        const backend = new SftpTransferBackend({ connect: async () => connection }, [localRoot], { localPlatform: "posix" });
        const manager = new OperationManager({ idFactory: () => `opened-${scenario}` });
        const service = new TransferService(manager, backend);
        const started = service.start({
          direction: "download", host, source: "/safe/source.bin", target, overwrite: false, recursive: false,
          expectedSourceIdentity: { kind: "file", id: "enumerated", size: 4 }
        });
        await terminal(manager, started.operationId);
        expect(closes).toBe(1);
        expect(manager.get(started.operationId)).toMatchObject(scenario === "close_failure"
          ? { state: "unknown", error: { code: ErrorCodes.STATE_UNKNOWN } }
          : scenario === "invalid_stat"
            ? { state: "failed", error: { code: ErrorCodes.PATH_DENIED } }
            : { state: "failed" });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(unhandled).toEqual([]);
      } finally {
        process.removeListener("unhandledRejection", listener);
      }
    }
  });
});

describe("AtomicTarget 提交语义", () => {
  it("目标存在且 overwrite=false 时在创建临时流前返回 TARGET_EXISTS", async () => {
    const port = atomicPort({ status: "file" });
    const target = new AtomicTarget("/safe/final", false, "posix", port, () => "fixed");
    await expect(target.open()).rejects.toMatchObject({ code: "TARGET_EXISTS" });
    expect(port.openExclusive).not.toHaveBeenCalled();
  });

  it("覆盖或无覆盖提交能力不可证明时在写临时内容前关闭失败", async () => {
    const replace = atomicPort({ status: "file", replace: false });
    await expect(new AtomicTarget("/safe/final", true, "posix", replace, () => "fixed").open())
      .rejects.toMatchObject({ code: "ATOMIC_REPLACE_UNSUPPORTED" });
    const noReplace = atomicPort({ status: "absent", noReplace: false });
    await expect(new AtomicTarget("/safe/final", false, "posix", noReplace, () => "fixed").open())
      .rejects.toMatchObject({ code: "ATOMIC_REPLACE_UNSUPPORTED" });
    expect(replace.openExclusive).not.toHaveBeenCalled();
    expect(noReplace.openExclusive).not.toHaveBeenCalled();
  });

  it("临时文件名固定为同目录随机 .part，流关闭校验后才执行无覆盖提交", async () => {
    const events: string[] = [];
    const port = atomicPort({ status: "absent", events });
    const target = new AtomicTarget("/safe/final", false, "posix", port, () => "1234");
    await target.open(); await target.seal(); await target.commit();
    expect(port.openExclusive).toHaveBeenCalledWith("/safe/.ssh-mcp-1234.part");
    expect(events).toEqual(["open", "seal", "commit-no-replace"]);
  });

  it("openExclusive 开始后即使拒绝也把临时路径视为可能存在并验证清理结果", async () => {
    let removals = 0;
    const port = atomicPort({ status: "absent" });
    port.openExclusive.mockRejectedValue(new Error("open failed after create"));
    port.remove = async () => { removals += 1; throw Object.assign(new Error("denied"), { code: "EACCES" }); };
    const target = new AtomicTarget("/safe/final", false, "posix", port, () => "maybe");
    await expect(target.open()).rejects.toMatchObject({ code: "TRANSFER_FAILED" });
    expect(target.temporaryMayExist).toBe(true);
    await expect(target.cleanup()).resolves.toBe(false);
    expect(removals).toBe(1);
  });
});

function backend(plan: Partial<PreparedTransfer> & Pick<PreparedTransfer, "source" | "target" | "totalBytes" | "commit">): TransferBackend {
  return { prepare: async () => ({ seal: async () => undefined, cleanup: async () => true, close: async () => undefined, ...plan }) };
}

async function terminal(manager: OperationManager, id: string): Promise<void> {
  await waitUntil(() => ["completed", "failed", "cancelled", "timed_out", "partial_failure", "unknown"].includes(manager.get(id).state));
}
async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  throw new Error("操作未在期限内结束");
}

async function waitUntilExpired(manager: OperationManager, id: string): Promise<void> {
  await waitUntil(() => {
    try {
      manager.get(id);
      return false;
    } catch (error: unknown) {
      return error instanceof OperationManagerError && error.code === "OPERATION_EXPIRED";
    }
  });
}

function atomicPort(options: { status: "absent" | "file"; replace?: boolean; noReplace?: boolean; events?: string[] }): AtomicTargetPort & { openExclusive: ReturnType<typeof vi.fn> } {
  const events = options.events ?? [];
  const writer: TemporaryWriter = {
    stream: new PassThrough(),
    seal: async () => { events.push("seal"); },
    forceDestroy: () => undefined,
    stop: async () => undefined
  };
  return {
    inspect: async () => options.status,
    supportsAtomicReplace: () => options.replace ?? true,
    supportsNoReplace: () => options.noReplace ?? true,
    openExclusive: vi.fn(async () => { events.push("open"); return writer; }),
    commitNoReplace: async () => { events.push("commit-no-replace"); return true; },
    commitReplace: async () => { events.push("commit-replace"); return true; },
    remove: async () => undefined
  };
}
