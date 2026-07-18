import { randomUUID, timingSafeEqual } from "node:crypto";
import { open, readFile, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ErrorCodes } from "../errors/error-codes.js";

export interface TrustIdentity {
  readonly alias: string;
  readonly configuredHost: string;
  readonly port: number;
}

export interface PublicHostKey {
  readonly algorithm: string;
  readonly fingerprint: string;
  readonly rawKey: Buffer;
}

export interface TrustedHostKey extends PublicHostKey {
  readonly confirmedAt: string;
}

interface StoredHostKey {
  readonly algorithm: string;
  readonly fingerprint: string;
  readonly publicKeyBase64: string;
  readonly confirmedAt: string;
}

interface StoredTrustStore {
  readonly version: 1;
  readonly hosts: Record<string, StoredHostKey>;
}

export interface TrustStoreFileHandle {
  writeFile(data: string, options: { encoding: "utf8" }): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface TrustStoreFileSystem {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  open(path: string, flags: string, mode?: number): Promise<TrustStoreFileHandle>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export class TrustStoreError extends Error {
  public readonly code = ErrorCodes.TRUST_STORE_ERROR;

  public constructor(message = "信任存储操作失败", options?: ErrorOptions) {
    super(message, options);
    this.name = "TrustStoreError";
  }
}

export class TrustStoreConflictError extends TrustStoreError {
  public constructor(public readonly trusted: TrustedHostKey) {
    super("持久化前主机信任已发生变化");
    this.name = "TrustStoreConflictError";
  }
}

const nodeFileSystem: TrustStoreFileSystem = {
  readFile,
  open: async (path, flags, mode) => await open(path, flags, mode) as FileHandle,
  rename,
  unlink
};

export class TrustStore {
  public constructor(
    private readonly path: string,
    private readonly fileSystem: TrustStoreFileSystem = nodeFileSystem,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  public async lookup(identity: TrustIdentity): Promise<TrustedHostKey | undefined> {
    const store = await this.readStore();
    return decodeRecord(store.hosts[trustKey(identity)]);
  }

  public async remember(identity: TrustIdentity, key: PublicHostKey, signal?: AbortSignal): Promise<void> {
    rejectIfAborted(signal);
    const lockPath = `${this.path}.lock`;
    let lock: TrustStoreFileHandle;
    try {
      lock = await this.fileSystem.open(lockPath, "wx", 0o600);
    } catch (error: unknown) {
      throw new TrustStoreError("无法取得信任存储锁", { cause: error });
    }

    let operationError: unknown;
    try {
      rejectIfAborted(signal);
      const store = await this.readStore();
      rejectIfAborted(signal);
      const current = decodeRecord(store.hosts[trustKey(identity)]);
      if (current !== undefined) {
        if (current.rawKey.length !== key.rawKey.length || !timingSafeEqual(current.rawKey, key.rawKey)) {
          throw new TrustStoreConflictError(current);
        }
      } else {
        const updated: StoredTrustStore = {
          version: 1,
          hosts: {
            ...store.hosts,
            [trustKey(identity)]: {
              algorithm: key.algorithm,
              fingerprint: key.fingerprint,
              publicKeyBase64: key.rawKey.toString("base64"),
              confirmedAt: this.now()
            }
          }
        };
        rejectIfAborted(signal);
        await this.atomicWrite(updated, signal);
      }
    } catch (error: unknown) {
      operationError = error;
    } finally {
      let releaseError: unknown;
      try {
        await lock.close();
      } catch (error: unknown) {
        releaseError = error;
      }
      try {
        await this.fileSystem.unlink(lockPath);
      } catch (error: unknown) {
        releaseError ??= error;
      }
      operationError ??= releaseError === undefined
        ? undefined
        : new TrustStoreError("无法释放信任存储锁", { cause: releaseError });
    }
    if (operationError !== undefined) {
      throw operationError instanceof TrustStoreError
        ? operationError
        : new TrustStoreError(undefined, { cause: operationError });
    }
  }

  private async readStore(): Promise<StoredTrustStore> {
    let source: string;
    try {
      source = await this.fileSystem.readFile(this.path, "utf8");
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { version: 1, hosts: {} };
      }
      throw new TrustStoreError("无法读取信任存储", { cause: error });
    }
    try {
      return parseStore(JSON.parse(source));
    } catch (error: unknown) {
      throw new TrustStoreError("信任存储内容损坏", { cause: error });
    }
  }

  private async atomicWrite(store: StoredTrustStore, signal?: AbortSignal): Promise<void> {
    const temporaryPath = join(dirname(this.path), `.${basename(this.path)}.${randomUUID()}.tmp`);
    let temporary: TrustStoreFileHandle | undefined;
    let renamed = false;
    try {
      rejectIfAborted(signal);
      temporary = await this.fileSystem.open(temporaryPath, "wx", 0o600);
      rejectIfAborted(signal);
      await temporary.writeFile(`${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8" });
      rejectIfAborted(signal);
      await temporary.sync();
      rejectIfAborted(signal);
      await temporary.close();
      temporary = undefined;
      rejectIfAborted(signal);
      await this.fileSystem.rename(temporaryPath, this.path);
      renamed = true;
    } catch (error: unknown) {
      throw new TrustStoreError("无法原子更新信任存储", { cause: error });
    } finally {
      if (temporary !== undefined) {
        await temporary.close().catch(() => undefined);
      }
      if (!renamed) {
        await this.fileSystem.unlink(temporaryPath).catch(() => undefined);
      }
    }
  }
}

function trustKey(identity: TrustIdentity): string {
  return `${identity.alias}|${identity.configuredHost}|${identity.port}`;
}

function decodeRecord(record: StoredHostKey | undefined): TrustedHostKey | undefined {
  if (record === undefined) {
    return undefined;
  }
  return Object.freeze({
    algorithm: record.algorithm,
    fingerprint: record.fingerprint,
    rawKey: Buffer.from(record.publicKeyBase64, "base64"),
    confirmedAt: record.confirmedAt
  });
}

function parseStore(value: unknown): StoredTrustStore {
  if (!isPlainObject(value) || !hasExactKeys(value, ["version", "hosts"])
    || value.version !== 1 || !isPlainObject(value.hosts)) {
    throw new Error("version 1 信任存储格式无效");
  }
  const hosts: Record<string, StoredHostKey> = {};
  for (const [key, record] of Object.entries(value.hosts)) {
    if (!isPlainObject(record) || !hasExactKeys(record, ["algorithm", "fingerprint", "publicKeyBase64", "confirmedAt"])
      || typeof record.algorithm !== "string"
      || typeof record.fingerprint !== "string"
      || typeof record.publicKeyBase64 !== "string"
      || typeof record.confirmedAt !== "string") {
      throw new Error("信任记录格式无效");
    }
    const rawKey = Buffer.from(record.publicKeyBase64, "base64");
    if (rawKey.length === 0 || rawKey.toString("base64") !== record.publicKeyBase64) {
      throw new Error("信任记录公钥无效");
    }
    hosts[key] = {
      algorithm: record.algorithm,
      fingerprint: record.fingerprint,
      publicKeyBase64: record.publicKeyBase64,
      confirmedAt: record.confirmedAt
    };
  }
  return { version: 1, hosts };
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index]);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function rejectIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new TrustStoreError("信任存储操作已取消");
  }
}
