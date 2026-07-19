import { PassThrough, Readable } from "node:stream";
import { join } from "node:path";
import { lstat, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { HostConfig } from "../../src/config/schema.js";
import { ErrorCodes } from "../../src/errors/error-codes.js";
import { OperationManager } from "../../src/operations/operation-manager.js";
import { executeBoundedProbe } from "../../src/ssh/bounded-probe.js";
import { createSourceMountVerifier, SftpDirectoryTransferBackend, withFreshMountEvidence } from "../../src/transfers/directory-transfer-backend.js";
import type { SftpTransferSession, SshConnection } from "../../src/ssh/ssh-adapter.js";
import { DirectoryWalker, type DirectoryWalkPort } from "../../src/transfers/directory-walker.js";
import {
  DirectoryTransferService,
  DirectoryTransferSetupError,
  type DirectoryTransferBackend,
  type PreparedDirectoryTransfer
} from "../../src/transfers/directory-transfer.js";
import { TransferPreparationError, type PreparedTransfer, type TransferRequest } from "../../src/transfers/file-transfer.js";

const host: HostConfig = {
  alias: "linux", environment: "test", platform: "linux", host: "127.0.0.1", port: 22,
  username: "tester", auth: { type: "privateKeyFile", path: "/tmp/key" },
  shell: { type: "posix", command: "/bin/sh" }, remoteRoots: ["/safe"]
};

describe("DirectoryWalker", () => {
  it("忽略底层枚举顺序，按规范相对路径代码点排序并保留空目录", async () => {
    const nodes = new Map<string, TestWalkNode>([
      ["/root", { ...walkStat("directory", 0, "r"), children: ["z.bin", "empty", "a"] }],
      ["/root/a", { ...walkStat("directory", 0, "a"), children: ["二.bin", "b.bin"] }],
      ["/root/a/b.bin", walkStat("file", 2, "b")],
      ["/root/a/二.bin", walkStat("file", 3, "u")],
      ["/root/empty", { ...walkStat("directory", 0, "e"), children: [] }],
      ["/root/z.bin", walkStat("file", 1, "z")]
    ]);
    const result = await new DirectoryWalker(port(nodes), "posix").walk("/root");
    expect(result.map(({ relativePath, kind }) => `${kind}:${relativePath}`)).toEqual([
      "directory:a", "file:a/b.bin", "file:a/二.bin", "directory:empty", "file:z.bin"
    ]);
  });

  it("拒绝链接、未知类型和非法目录项，不读取链接目标", async () => {
    let listedLink = false;
    const unsafe: DirectoryWalkPort = {
      inspect: async (path) => path === "/root" ? walkStat("directory", 0, "root")
        : { ...walkStat("directory", 0, "link"), kind: "symlink" },
      list: async (path) => {
        if (path === "/root/link") listedLink = true;
        return ["link"];
      }
    };
    await expect(new DirectoryWalker(unsafe, "posix").walk("/root")).rejects.toMatchObject({ code: ErrorCodes.LINK_NOT_ALLOWED });
    expect(listedLink).toBe(false);
    for (const name of ["", ".", "..", "a/b", "a\0b", "/abs"]) {
      await expect(new DirectoryWalker({
        inspect: async () => walkStat("directory", 0, "root"),
        list: async () => [name]
      }, "posix").walk("/root")).rejects.toMatchObject({ code: ErrorCodes.PATH_DENIED });
    }
  });

  it("拒绝根、树内 mount 与未知挂载证据", async () => {
    const rootMount = new Map<string, TestWalkNode>([
      ["/root", { ...walkStat("directory", 0, "root"), mountPoint: true, children: ["file"] }],
      ["/root/file", { ...walkStat("file", 1, "file"), mountPoint: false }]
    ]);
    await expect(new DirectoryWalker(port(rootMount), "posix").walk("/root"))
      .rejects.toMatchObject({ code: ErrorCodes.PATH_DENIED });

    for (const mountPoint of [true, "unknown"] as const) {
      const nodes = new Map<string, TestWalkNode>([
        ["/root", { ...walkStat("directory", 0, "root"), children: ["child"] }],
        ["/root/child", { ...walkStat("directory", 0, "child"), mountPoint, children: [] }]
      ]);
      await expect(new DirectoryWalker(port(nodes), "posix").walk("/root"))
        .rejects.toMatchObject({ code: ErrorCodes.PATH_DENIED });
    }
  });

  it("挂载证据在敏感访问前后变化时关闭失败", async () => {
    const snapshots = [new Set(["/"]), new Set(["/", "/root/child"])];
    let accesses = 0;
    await expect(withFreshMountEvidence(
      async () => snapshots.shift()!,
      async () => { accesses += 1; return "value"; }
    )).rejects.toMatchObject({ code: ErrorCodes.PATH_DENIED });
    expect(accesses).toBe(1);
    expect(snapshots).toHaveLength(0);
  });

  it("相邻访问之间新增的源树祖先挂载在下一次访问前关闭失败，但不把全局根挂载当禁区", async () => {
    const snapshots = [
      new Set(["/"]), new Set(["/"]),
      new Set(["/", "/root/child"])
    ];
    const verifier = createSourceMountVerifier("/root", "posix", async () => snapshots.shift()!);
    let accesses = 0;
    await expect(verifier.withFresh("/root", async () => { accesses += 1; return "listed"; }))
      .resolves.toBe("listed");
    await expect(verifier.withFresh("/root/child/file.bin", async () => { accesses += 1; return "opened"; }))
      .rejects.toMatchObject({ code: ErrorCodes.PATH_DENIED });
    expect(accesses).toBe(1);
  });
});

describe("有界执行探针", () => {
  it("stdout 或 stderr 超限时立即销毁 channel、只结算一次且忽略迟到数据", async () => {
    for (const stream of ["stdout", "stderr"] as const) {
      const channel = new FakeProbeChannel();
      const pending = executeBoundedProbe({ exec: (_command, callback) => callback(undefined, channel) }, "fixed", 4);
      channel.emitData(stream, Buffer.from("12345"));
      let lateConversions = 0;
      channel.emitData(stream, {
        valueOf: () => { lateConversions += 1; return "late"; }
      } as unknown as string);
      channel.emitError(new Error("late"));
      channel.emitClose(0);
      await expect(pending).rejects.toMatchObject({ code: ErrorCodes.PATH_DENIED });
      expect(channel.destroyCalls).toBe(1);
      expect(lateConversions).toBe(0);
    }
  });
});

describe("DirectoryTransferService", () => {
  it("生产目录后端的 lstat 挂起时，超时会关闭 SFTP 与连接各一次", async () => {
    let sftpCloses = 0;
    let connectionCloses = 0;
    const sftp: SftpTransferSession = {
      lstat: async () => await new Promise<never>(() => undefined),
      realpath: async (value) => value,
      createReadStream: () => new PassThrough(),
      createWriteStream: () => new PassThrough(),
      readdir: async () => [],
      mkdir: async () => undefined,
      supportsAtomicReplace: false,
      supportsHardlink: false,
      atomicReplace: async () => undefined,
      hardlink: async () => undefined,
      unlink: async () => undefined,
      close: () => { sftpCloses += 1; }
    };
    const manager = new OperationManager({
      idFactory: () => "directory-hung-lstat",
      limits: { transferTimeoutMs: 5, cancelConfirmationTimeoutMs: 50 }
    });
    const service = new DirectoryTransferService(manager, new SftpDirectoryTransferBackend({
      connect: async () => ({
        exec: () => undefined,
        openShell: () => undefined,
        openSftp: (callback) => callback(undefined, sftp),
        close: () => { connectionCloses += 1; }
      })
    }, ["/local"], { localPlatform: "posix" }));

    const started = service.start({
      direction: "download", host, source: "/safe/tree", target: "/local/tree", overwrite: false, recursive: true
    });
    await terminal(manager, started.operationId);

    expect(manager.get(started.operationId)).toMatchObject({ state: "timed_out" });
    expect(sftpCloses).toBe(1);
    expect(connectionCloses).toBe(1);
  });

  it("目录先于子项创建，普通文件严格串行并发布累计进度和稳定逐项结果", async () => {
    const calls: string[] = [];
    const manager = new OperationManager({ idFactory: () => "directory-ok" });
    const service = new DirectoryTransferService(manager, backend(preparedDirectory(calls, [
      { relativePath: "a", kind: "directory", size: 0, id: "d" },
      { relativePath: "a/one.bin", kind: "file", size: 3, id: "1" },
      { relativePath: "z.bin", kind: "file", size: 2, id: "2" }
    ], new Map([
      ["a/one.bin", transfer(Buffer.from([1, 2, 3]))],
      ["z.bin", transfer(Buffer.from([4, 5]))]
    ]))));
    const started = service.start(request());
    await terminal(manager, started.operationId);
    expect(calls).toEqual(["root", "dir:a", "prepare:a/one.bin", "commit:a/one.bin", "prepare:z.bin", "commit:z.bin", "close"]);
    expect(manager.get(started.operationId)).toMatchObject({
      state: "completed",
      result: {
        currentItem: "z.bin", transferredBytes: 2, totalBytes: 2,
        aggregateTransferredBytes: 5, completedItems: 2, totalItems: 2,
        succeeded: ["a/one.bin", "z.bin"], failed: [], notExecuted: []
      }
    });
  });

  it("首个失败后停止，保留成功项并把剩余项归入 notExecuted，不回滚已完成项", async () => {
    const calls: string[] = [];
    const failure = transfer(Buffer.from("bad"), { seal: async () => { throw Object.assign(new Error("boom"), { code: ErrorCodes.TRANSFER_FAILED }); } });
    const manager = new OperationManager({ idFactory: () => "directory-partial" });
    const service = new DirectoryTransferService(manager, backend(preparedDirectory(calls, files("a", "b", "c"), new Map([
      ["a", transfer(Buffer.from("a"))], ["b", failure], ["c", transfer(Buffer.from("c"))]
    ]))));
    const started = service.start(request());
    await terminal(manager, started.operationId);
    expect(calls).not.toContain("prepare:c");
    expect(manager.get(started.operationId)).toMatchObject({
      state: "partial_failure", error: { code: ErrorCodes.PARTIAL_FAILURE, sideEffects: "partial" },
      result: {
        succeeded: ["a"],
        failed: [{ relativePath: "b", code: ErrorCodes.TRANSFER_FAILED, safety: "confirmed" }],
        notExecuted: ["c"], completedItems: 1, totalItems: 3
      }
    });
  });

  it("逐文件准备错误保留原始错误码，并把清理或资源关闭不确定性提升为 unknown", async () => {
    for (const scenario of ["close", "cleanup_failed", "cleanup_unknown"] as const) {
      const original = Object.assign(new Error(scenario), { code: ErrorCodes.PATH_DENIED });
      const preparationError = scenario === "close"
        ? new TransferPreparationError(original, "not_needed", true)
        : new TransferPreparationError(original, scenario === "cleanup_failed" ? "failed" : "unknown");
      const manager = new OperationManager({ idFactory: () => `directory-preparation-${scenario}` });
      const prepared = preparedDirectory([], files("a", "b"), new Map());
      const service = new DirectoryTransferService(manager, backend({
        ...prepared,
        prepareFile: async () => { throw preparationError; }
      }));
      const unhandled: unknown[] = [];
      const listener = (error: unknown): void => { unhandled.push(error); };
      process.on("unhandledRejection", listener);
      try {
        const started = service.start(request());
        await terminal(manager, started.operationId);
        expect(manager.get(started.operationId)).toMatchObject({
          state: "unknown",
          error: { code: ErrorCodes.STATE_UNKNOWN },
          result: {
            succeeded: [],
            failed: [{ relativePath: "a", code: ErrorCodes.PATH_DENIED, safety: "unknown" }],
            notExecuted: ["b"],
            issues: [scenario === "close"
              ? { relativePath: "a", kind: "close", resourceCloseFailed: true }
              : { relativePath: "a", kind: "cleanup", temporaryCleanup: scenario === "cleanup_failed" ? "failed" : "unknown" }]
          }
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(unhandled).toEqual([]);
      } finally {
        process.removeListener("unhandledRejection", listener);
      }
    }
  });

  it("逐文件准备阶段的非法 stat 或目标守卫错误保持稳定错误码和 confirmed 分类", async () => {
    for (const code of [ErrorCodes.PATH_DENIED, ErrorCodes.TARGET_EXISTS] as const) {
      const manager = new OperationManager({ idFactory: () => `directory-preparation-${code}` });
      const prepared = preparedDirectory([], files("a", "b"), new Map());
      const service = new DirectoryTransferService(manager, backend({
        ...prepared,
        prepareFile: async () => {
          throw new TransferPreparationError(Object.assign(new Error(code), { code }), "not_needed", false);
        }
      }));
      const started = service.start(request());
      await terminal(manager, started.operationId);
      expect(manager.get(started.operationId)).toMatchObject({
        state: "partial_failure",
        result: {
          failed: [{ relativePath: "a", code, safety: "confirmed" }],
          notExecuted: ["b"]
        }
      });
    }
  });

  it("目录连接与逐文件连接处于不同 mount namespace 时，必须按实际 opened handle 所在连接拒绝", async () => {
    for (const closeFailure of [false, true]) {
      const localRoot = await mkdtemp(join(await realpath(tmpdir()), "ssh-mcp-directory-mount-"));
      const targetRoot = join(localRoot, "target");
      let openedCloses = 0;
      let directoryProbeCalls = 0;
      let fileProbeCalls = 0;
      let sourceReads = 0;
      let sftpCloses = 0;
      let connectionCloses = 0;
      const unhandled: unknown[] = [];
      const listener = (error: unknown): void => { unhandled.push(error); };
      process.on("unhandledRejection", listener);
      try {
        const sftp: SftpTransferSession = {
          lstat: async (target) => {
            if (target === "/") return { kind: "directory", id: "slash", size: 0 };
            if (target === "/safe") return { kind: "directory", id: "safe", size: 0 };
            if (target === "/safe/source") return { kind: "directory", id: "source", size: 0 };
            if (target === "/safe/source/a.bin") return { kind: "file", id: "file", size: 4 };
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
          },
          realpath: async (target) => target,
          readdir: async () => ["a.bin"],
          mkdir: async () => undefined,
          createReadStream: () => { throw new Error("目录下载必须使用 opened handle"); },
          openReadFile: async () => ({
              stream: new Readable({
                read: () => {
                  sourceReads += 1;
                  throw new Error("挂载证明失败前不得读取源数据");
                }
              }),
              stat: { kind: "file", id: "file", size: 4 },
              close: async () => { openedCloses += 1; if (closeFailure) throw new Error("close failed"); }
            }),
          createWriteStream: () => { throw new Error("不应创建远端目标"); },
          supportsAtomicReplace: true,
          supportsHardlink: true,
          atomicReplace: async () => undefined,
          hardlink: async () => undefined,
          unlink: async () => undefined,
          close: () => { sftpCloses += 1; }
        };
        const directoryConnection: SshConnection = {
          exec: (_command, callback) => {
            directoryProbeCalls += 1;
            const channel = new FakeProbeChannel();
            callback(undefined, channel as never);
            setImmediate(() => {
              channel.emitData("stdout", "1 0 0:1 / / rw - ext4 root rw\n");
              channel.emitClose(0);
            });
          },
          openShell: () => undefined,
          openSftp: (callback) => callback(undefined, sftp),
          close: () => { connectionCloses += 1; }
        };
        const fileConnection: SshConnection = {
          exec: (_command, callback) => {
            fileProbeCalls += 1;
            const channel = new FakeProbeChannel();
            callback(undefined, channel as never);
            setImmediate(() => {
              channel.emitData("stdout", fileProbeCalls === 1
                ? "1 0 0:1 / / rw - ext4 root rw\n"
                : "1 0 0:1 / / rw - ext4 root rw\n2 1 0:2 / /safe/source rw - none bind rw\n");
              channel.emitClose(0);
            });
          },
          openShell: () => undefined,
          openSftp: (callback) => callback(undefined, sftp),
          close: () => { connectionCloses += 1; }
        };
        let connects = 0;
        const backend = new SftpDirectoryTransferBackend({ connect: async () => {
          connects += 1;
          return connects === 1 ? directoryConnection : fileConnection;
        } }, [localRoot], { localPlatform: "posix" });
        const manager = new OperationManager({ idFactory: () => `directory-real-mount-${closeFailure}` });
        const service = new DirectoryTransferService(manager, backend);
        const started = service.start({
          direction: "download", host, source: "/safe/source", target: targetRoot,
          overwrite: false, recursive: true
        });
        await terminal(manager, started.operationId);
        expect(openedCloses).toBe(1);
        expect(sourceReads).toBe(0);
        expect(directoryProbeCalls).toBeGreaterThan(0);
        expect(fileProbeCalls).toBe(2);
        expect(sftpCloses).toBe(2);
        expect(connectionCloses).toBe(2);
        expect(manager.get(started.operationId)).toMatchObject(closeFailure
          ? {
              state: "unknown",
              result: { failed: [{ relativePath: "a.bin", code: ErrorCodes.PATH_DENIED, safety: "unknown" }] }
            }
          : {
              state: "partial_failure",
              result: { failed: [{ relativePath: "a.bin", code: ErrorCodes.PATH_DENIED, safety: "confirmed" }] }
            });
        await expect(lstat(join(targetRoot, "a.bin"))).rejects.toMatchObject({ code: "ENOENT" });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(unhandled).toEqual([]);
      } finally {
        process.removeListener("unhandledRejection", listener);
      }
    }
  });

  it("最终文件已提交但 part 清理或资源关闭失败时保留 succeeded、停止后续项并返回 partial_failure", async () => {
    for (const kind of ["cleanup", "close"] as const) {
      const calls: string[] = [];
      const problematic = transfer(Buffer.from("a"), kind === "cleanup"
        ? { commit: async () => "failed" }
        : { close: async () => { throw new Error("close failed"); } });
      const manager = new OperationManager({ idFactory: () => `post-commit-${kind}` });
      const service = new DirectoryTransferService(manager, backend(preparedDirectory(calls, files("a", "b"), new Map([
        ["a", problematic], ["b", transfer(Buffer.from("b"))]
      ]))));
      const started = service.start(request());
      await terminal(manager, started.operationId);
      expect(calls).not.toContain("prepare:b");
      expect(manager.get(started.operationId)).toMatchObject({
        state: "partial_failure", error: { code: ErrorCodes.PARTIAL_FAILURE, sideEffects: "partial" },
        result: {
          succeeded: ["a"], failed: [], notExecuted: ["b"],
          issues: [{ relativePath: "a", code: ErrorCodes.PARTIAL_FAILURE, kind }]
        }
      });
    }
  });

  it("目标根创建响应不确定时不得报告零副作用 failed", async () => {
    const manager = new OperationManager({ idFactory: () => "root-unknown" });
    const prepared = preparedDirectory([], [], new Map());
    const service = new DirectoryTransferService(manager, backend({
      ...prepared,
      createTargetRoot: async () => { throw Object.assign(new Error("reply lost"), { targetCreation: "unknown" }); }
    }));
    const started = service.start(request());
    await terminal(manager, started.operationId);
    expect(manager.get(started.operationId)).toMatchObject({
      state: "unknown", error: { code: ErrorCodes.STATE_UNKNOWN, sideEffects: "possible" }
    });
  });

  it("已有文件成功后子目录创建失败时用独立 issue 表示，文件三分类仍互斥且完备", async () => {
    const calls: string[] = [];
    const prepared = preparedDirectory(calls, [
      { relativePath: "a.bin", kind: "file", size: 1, id: "a" },
      { relativePath: "b", kind: "directory", size: 0, id: "b" },
      { relativePath: "b/c.bin", kind: "file", size: 1, id: "c" }
    ], new Map([["a.bin", transfer(Buffer.from("a"))], ["b/c.bin", transfer(Buffer.from("c"))]]));
    const manager = new OperationManager({ idFactory: () => "directory-create-failed" });
    const service = new DirectoryTransferService(manager, backend({
      ...prepared,
      createDirectory: async (entry) => { calls.push(`dir:${entry.relativePath}`); throw Object.assign(new Error("denied"), { code: ErrorCodes.PATH_DENIED }); }
    }));
    const started = service.start(request());
    await terminal(manager, started.operationId);
    const result = manager.get(started.operationId).result!;
    expect(manager.get(started.operationId)).toMatchObject({
      state: "partial_failure",
      result: {
        succeeded: ["a.bin"], failed: [], notExecuted: ["b/c.bin"],
        issues: [{ relativePath: "b", code: ErrorCodes.PARTIAL_FAILURE, kind: "directory_create", cause: ErrorCodes.PATH_DENIED }]
      }
    });
    expect(new Set([...(result.succeeded as string[]), ...(result.failed as Array<{ relativePath: string }>).map((item) => item.relativePath), ...(result.notExecuted as string[])]).size).toBe(2);
  });

  it("子目录创建响应丢失时 unknown 优先并保留相对目录和未知证据", async () => {
    const calls: string[] = [];
    const prepared = preparedDirectory(calls, [
      { relativePath: "a", kind: "directory", size: 0, id: "a" },
      { relativePath: "a/file.bin", kind: "file", size: 1, id: "file" }
    ], new Map([["a/file.bin", transfer(Buffer.from("x"))]]));
    const manager = new OperationManager({ idFactory: () => "directory-create-unknown" });
    const service = new DirectoryTransferService(manager, backend({
      ...prepared,
      createDirectory: async () => { throw Object.assign(new Error("reply lost"), { targetCreation: "unknown" }); }
    }));
    const started = service.start(request());
    await terminal(manager, started.operationId);
    expect(manager.get(started.operationId)).toMatchObject({
      state: "unknown",
      error: { code: ErrorCodes.STATE_UNKNOWN, sideEffects: "partial" },
      result: {
        succeeded: [], failed: [], notExecuted: ["a/file.bin"],
        issues: [{ relativePath: "a", kind: "directory_create", targetCreation: "unknown", cause: ErrorCodes.STATE_UNKNOWN }]
      }
    });
    expect(calls).toEqual(["root", "close"]);
  });

  it("拒绝缺失父目录或把普通文件当父目录的后端枚举计划", async () => {
    for (const entries of [
      [{ relativePath: "a/b.bin", kind: "file" as const, size: 1, id: "b" }],
      [{ relativePath: "a", kind: "file" as const, size: 1, id: "a" }, { relativePath: "a/b.bin", kind: "file" as const, size: 1, id: "b" }]
    ]) {
      const manager = new OperationManager({ idFactory: () => `invalid-plan-${entries.length}` });
      const service = new DirectoryTransferService(manager, backend(preparedDirectory([], entries, new Map())));
      const started = service.start(request());
      await terminal(manager, started.operationId);
      expect(manager.get(started.operationId)).toMatchObject({ state: "failed", error: { code: ErrorCodes.PATH_DENIED, sideEffects: "none" } });
    }
  });

  it("目标根存在或源枚举不安全时在零目录副作用下失败，overwrite=true 不放宽", async () => {
    for (const overwrite of [false, true]) {
      let roots = 0;
      const manager = new OperationManager({ idFactory: () => `exists-${overwrite}` });
      const service = new DirectoryTransferService(manager, {
        prepare: async () => { throw new DirectoryTransferSetupError(ErrorCodes.TARGET_EXISTS); }
      });
      const started = service.start({ ...request(), overwrite });
      await terminal(manager, started.operationId);
      expect(roots).toBe(0);
      expect(manager.get(started.operationId)).toMatchObject({ state: "failed", error: { code: ErrorCodes.TARGET_EXISTS, sideEffects: "none" } });
    }
  });

  it("空目录仍创建目标根并以 0 items/0 bytes 完成", async () => {
    const calls: string[] = [];
    const manager = new OperationManager({ idFactory: () => "empty" });
    const service = new DirectoryTransferService(manager, backend(preparedDirectory(calls, [], new Map())));
    const started = service.start(request());
    await terminal(manager, started.operationId);
    expect(calls).toEqual(["root", "close"]);
    expect(manager.get(started.operationId)).toMatchObject({
      state: "completed", result: { aggregateTransferredBytes: 0, completedItems: 0, totalItems: 0, succeeded: [], failed: [], notExecuted: [] }
    });
  });

  it("取消不启动后续项；清理可确认时 cancelled，不可确认时 unknown 优先", async () => {
    for (const cleanup of [true, false]) {
      const calls: string[] = [];
      const source = new PassThrough();
      const manager = new OperationManager({ idFactory: () => `cancel-${cleanup}` });
      const service = new DirectoryTransferService(manager, backend(preparedDirectory(calls, files("a", "b"), new Map([
        ["a", transfer(source, { cleanup: async () => cleanup })], ["b", transfer(Buffer.from("b"))]
      ]))));
      const started = service.start(request());
      await waitUntil(() => calls.includes("prepare:a"));
      manager.cancel(started.operationId);
      await terminal(manager, started.operationId);
      expect(calls).not.toContain("prepare:b");
      expect(manager.get(started.operationId)).toMatchObject(cleanup
        ? { state: "cancelled", result: { succeeded: [], notExecuted: ["b"] } }
        : { state: "unknown", error: { code: ErrorCodes.STATE_UNKNOWN }, result: { succeeded: [], notExecuted: ["b"] } });
    }
  });

  it("prepare 迟到时先完整分类并 close-once，再确认普通取消", async () => {
    let release!: (prepared: PreparedDirectoryTransfer) => void;
    let closes = 0;
    const pending = new Promise<PreparedDirectoryTransfer>((resolve) => { release = resolve; });
    const manager = new OperationManager({ idFactory: () => "directory-late-prepare" });
    const service = new DirectoryTransferService(manager, { prepare: async () => await pending });
    const started = service.start(request());
    manager.cancel(started.operationId);
    release({
      ...preparedDirectory([], files("a"), new Map([["a", transfer(Buffer.from("a"))]])),
      close: async () => { closes += 1; }
    });
    await terminal(manager, started.operationId);
    expect(manager.get(started.operationId)).toMatchObject({
      state: "cancelled", result: { totalItems: 1, succeeded: [], failed: [], notExecuted: ["a"] }
    });
    expect(closes).toBe(1);
  });

  it("forceStop 与结果过期后的迟到 prepare 只做 close-once，不覆写终态且无未处理拒绝", async () => {
    let release!: (prepared: PreparedDirectoryTransfer) => void;
    let closes = 0;
    const unhandled: unknown[] = [];
    const listener = (error: unknown): void => { unhandled.push(error); };
    process.on("unhandledRejection", listener);
    try {
      const manager = new OperationManager({
        idFactory: () => "directory-expired-late-prepare",
        limits: { cancelConfirmationTimeoutMs: 5, resultRetentionMs: 5 }
      });
      const service = new DirectoryTransferService(manager, {
        prepare: async () => await new Promise<PreparedDirectoryTransfer>((resolve) => { release = resolve; })
      });
      const started = service.start(request());
      manager.cancel(started.operationId);
      await waitUntil(() => manager.get(started.operationId).state === "unknown");
      await waitUntil(() => {
        try { manager.get(started.operationId); return false; } catch { return true; }
      });
      release({
        ...preparedDirectory([], files("a"), new Map([["a", transfer(Buffer.from("a"))]])),
        close: async () => { closes += 1; }
      });
      await waitUntil(() => closes === 1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closes).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", listener);
    }
  });

  it("逐文件 prepare 已开始时 forceStop 将当前项记为 unknown failed，迟到对象 cleanup/close 各一次", async () => {
    let release!: (prepared: PreparedTransfer) => void;
    let cleanups = 0;
    let closes = 0;
    const unhandled: unknown[] = [];
    const listener = (error: unknown): void => { unhandled.push(error); };
    process.on("unhandledRejection", listener);
    try {
      const calls: string[] = [];
      const base = preparedDirectory(calls, files("a", "b"), new Map());
      const manager = new OperationManager({
        idFactory: () => "file-expired-late-prepare",
        limits: { cancelConfirmationTimeoutMs: 5, resultRetentionMs: 5 }
      });
      const service = new DirectoryTransferService(manager, backend({
        ...base,
        prepareFile: async (entry) => {
          calls.push(`prepare:${entry.relativePath}`);
          return await new Promise<PreparedTransfer>((resolve) => { release = resolve; });
        }
      }));
      const started = service.start(request());
      await waitUntil(() => calls.includes("prepare:a"));
      manager.cancel(started.operationId);
      await waitUntil(() => manager.get(started.operationId).state === "unknown");
      const frozen = manager.get(started.operationId);
      expect(frozen).toMatchObject({
        state: "unknown",
        result: {
          succeeded: [],
          failed: [{ relativePath: "a", code: ErrorCodes.STATE_UNKNOWN, safety: "unknown" }],
          notExecuted: ["b"]
        }
      });
      await waitUntil(() => {
        try { manager.get(started.operationId); return false; } catch { return true; }
      });
      release(transfer(Buffer.from("a"), {
        cleanup: async () => { cleanups += 1; return false; },
        close: async () => { closes += 1; }
      }));
      await waitUntil(() => cleanups === 1 && closes === 1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(frozen.result).toMatchObject({
        failed: [{ relativePath: "a", code: ErrorCodes.STATE_UNKNOWN }],
        notExecuted: ["b"]
      });
      expect(cleanups).toBe(1);
      expect(closes).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", listener);
    }
  });
});

function request(): TransferRequest {
  return { direction: "upload", host, source: "/local/source", target: "/safe/target", overwrite: false, recursive: true };
}
function files(...names: string[]) { return names.map((relativePath, index) => ({ relativePath, kind: "file" as const, size: 1, id: String(index) })); }
interface TestWalkNode {
  readonly kind: "file" | "directory";
  readonly size: number;
  readonly id: string;
  readonly mountPoint: boolean | "unknown";
  readonly children?: string[];
}
function walkStat(kind: "file" | "directory", size: number, id: string): TestWalkNode {
  return { kind, size, id, mountPoint: false };
}
function port(nodes: Map<string, TestWalkNode>): DirectoryWalkPort {
  return {
    inspect: async (path) => nodes.get(path)!,
    list: async (path) => nodes.get(path)?.children ?? []
  };
}
function backend(value: PreparedDirectoryTransfer): DirectoryTransferBackend { return { prepare: async () => value }; }
function preparedDirectory(calls: string[], entries: PreparedDirectoryTransfer["entries"], transfers: Map<string, PreparedTransfer>): PreparedDirectoryTransfer {
  return {
    entries,
    createTargetRoot: async () => { calls.push("root"); },
    createDirectory: async (entry) => { calls.push(`dir:${entry.relativePath}`); },
    prepareFile: async (entry) => { calls.push(`prepare:${entry.relativePath}`); const item = transfers.get(entry.relativePath)!; const commit = item.commit; return { ...item, commit: async () => { calls.push(`commit:${entry.relativePath}`); return await commit(); } }; },
    close: async () => { calls.push("close"); }
  };
}
function transfer(source: Buffer | PassThrough, overrides: Partial<PreparedTransfer> = {}): PreparedTransfer {
  const readable = Buffer.isBuffer(source) ? Readable.from([source]) : source;
  return {
    source: readable, target: new PassThrough(), totalBytes: Buffer.isBuffer(source) ? source.length : 100,
    seal: async () => undefined, commit: async () => undefined, cleanup: async () => true, close: async () => undefined,
    ...overrides
  };
}
async function terminal(manager: OperationManager, id: string): Promise<void> {
  await waitUntil(() => ["completed", "failed", "partial_failure", "timed_out", "cancelled", "unknown"].includes(manager.get(id).state));
}
async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  throw new Error("测试等待超时");
}

class FakeProbeChannel {
  public readonly stdoutListeners: Array<(chunk: Buffer | string) => void> = [];
  public readonly stderrListeners: Array<(chunk: Buffer | string) => void> = [];
  public readonly errorListeners: Array<(error: Error) => void> = [];
  public readonly closeListeners: Array<(code: number | undefined) => void> = [];
  public destroyCalls = 0;
  public readonly stderr = {
    on: (_event: "data", listener: (chunk: Buffer | string) => void): void => { this.stderrListeners.push(listener); }
  };
  public on(event: "data" | "error" | "close", listener: ((chunk: Buffer | string) => void) | ((error: Error) => void) | ((code: number | undefined) => void)): this {
    if (event === "data") this.stdoutListeners.push(listener as (chunk: Buffer | string) => void);
    if (event === "error") this.errorListeners.push(listener as (error: Error) => void);
    if (event === "close") this.closeListeners.push(listener as (code: number | undefined) => void);
    return this;
  }
  public destroy(): this { this.destroyCalls += 1; return this; }
  public emitData(stream: "stdout" | "stderr", chunk: Buffer | string): void {
    for (const listener of stream === "stdout" ? this.stdoutListeners : this.stderrListeners) listener(chunk);
  }
  public emitError(error: Error): void { for (const listener of this.errorListeners) listener(error); }
  public emitClose(code: number): void { for (const listener of this.closeListeners) listener(code); }
}
