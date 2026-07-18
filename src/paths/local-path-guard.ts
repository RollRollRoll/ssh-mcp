import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { ErrorCodes } from "../errors/error-codes.js";
import { PathGuardError, type LexicalPathHandle, type PathPlatform, lexicalPathHandle, pathSegments } from "./path-guard.js";

export { PathGuardError, lexicalPathHandle } from "./path-guard.js";
export type { LexicalPathHandle, PathPlatform } from "./path-guard.js";

export interface PathStat {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
  readonly dev?: number;
  readonly ino?: number;
}

export interface LocalOpenFile {
  stat(): Promise<PathStat>;
  close(): Promise<void>;
}

export interface LocalFileSystem {
  lstat(path: string): Promise<PathStat>;
  realpath(path: string): Promise<string>;
  open(path: string, flags?: string | number): Promise<LocalOpenFile>;
}

export interface LocalPathGuardOptions {
  readonly platform: PathPlatform;
  readonly fileSystem?: LocalFileSystem;
}

interface ExistingEntry { readonly path: string; readonly identity: PathIdentity; }
interface PathIdentity { readonly type: "file" | "directory"; readonly dev: number; readonly ino: number; }

export interface LocalSafePathHandle extends LexicalPathHandle {
  revalidateBeforeOpen(): Promise<void>;
  openReadOnly(): Promise<LocalOpenFile>;
}

const systemFileSystem: LocalFileSystem = { lstat, realpath, open };

/** 批准后才调用 verify；构造和 lexical 均不触发 I/O。 */
export class LocalPathGuard {
  private readonly fileSystem: LocalFileSystem;
  public constructor(private readonly roots: readonly string[], private readonly options: LocalPathGuardOptions) {
    this.fileSystem = options.fileSystem ?? systemFileSystem;
  }

  public lexical(requested: string): LexicalPathHandle { return lexicalPathHandle(requested, this.roots, this.options.platform); }

  public async verify(requested: string): Promise<LocalSafePathHandle> {
    const lexical = this.lexical(requested);
    const preflight = await this.inspect(lexical);
    return Object.freeze({
      ...lexical,
      revalidateBeforeOpen: async () => { await this.revalidate(lexical, preflight); },
      openReadOnly: async () => await this.openReadOnly(lexical, preflight)
    });
  }

  private async openReadOnly(lexical: LexicalPathHandle, preflight: readonly ExistingEntry[]): Promise<LocalOpenFile> {
    try { await this.revalidate(lexical, preflight); } catch { throw new PathGuardError(); }
    // 不存在的最终目标没有可在打开后复核的预检身份。拒绝打开而非依赖
    // Windows 会跟随重解析点的普通读打开，句柄仍可用于祖先的后续复核。
    if (!preflight.some((entry) => entry.path === lexical.canonical)) throw new PathGuardError();
    let file: LocalOpenFile | undefined;
    try {
      file = await this.fileSystem.open(lexical.canonical, this.options.platform === "posix" ? constants.O_RDONLY | constants.O_NOFOLLOW : "r");
      const expected = preflight.find((entry) => entry.path === lexical.canonical);
      if (expected !== undefined && !sameIdentity(expected.identity, identityOf(await file.stat()))) throw new PathGuardError();
      return file;
    } catch (error: unknown) {
      await file?.close();
      if (error instanceof PathGuardError) throw error;
      throw new PathGuardError();
    }
  }

  private async revalidate(lexical: LexicalPathHandle, preflight: readonly ExistingEntry[]): Promise<void> {
    const next = await this.inspect(lexical);
    if (next.length !== preflight.length || next.some((entry, index) => entry.path !== preflight[index]?.path || !sameIdentity(entry.identity, preflight[index]!.identity))) {
      throw new PathGuardError();
    }
  }

  private async inspect(lexical: LexicalPathHandle): Promise<readonly ExistingEntry[]> {
    const segments = pathSegments(lexical.canonical, this.options.platform);
    const rootSegments = pathSegments(lexical.root, this.options.platform).length;
    const existing: ExistingEntry[] = [];
    for (let index = 0; index < segments.length; index += 1) {
      const candidate = buildPath(segments.slice(0, index + 1), this.options.platform);
      let status: PathStat;
      try { status = await this.fileSystem.lstat(candidate); } catch (error: unknown) {
        if (isNotFound(error)) break;
        throw new PathGuardError();
      }
      const identity = identityOf(status);
      if (index < segments.length - 1 && identity.type !== "directory") throw new PathGuardError();
      const canonical = await this.safeRealpath(candidate);
      if (index + 1 >= rootSegments && !isCanonicalWithin(canonical, lexical.root, this.options.platform)) throw new PathGuardError();
      existing.push({ path: candidate, identity });
    }
    if (existing.length === 0) throw new PathGuardError();
    return Object.freeze(existing);
  }

  private async safeRealpath(value: string): Promise<string> {
    try { return await this.fileSystem.realpath(value); } catch { throw new PathGuardError(); }
  }
}

function buildPath(segments: readonly string[], platform: PathPlatform): string {
  if (platform === "posix") return `/${segments.slice(1).join("/")}`;
  return `${segments[0]}${segments.slice(1).join("\\")}`;
}

function identityOf(stat: PathStat): PathIdentity {
  let symbolicLink: unknown;
  let file: unknown;
  let directory: unknown;
  try {
    symbolicLink = stat.isSymbolicLink();
    file = stat.isFile();
    directory = stat.isDirectory();
  } catch { throw new PathGuardError(); }
  if (symbolicLink === true) throw new PathGuardError(ErrorCodes.LINK_NOT_ALLOWED);
  if (symbolicLink !== false || typeof file !== "boolean" || typeof directory !== "boolean" || file === directory) throw new PathGuardError();
  if (!isStableIdentityNumber(stat.dev) || !isStableIdentityNumber(stat.ino)) throw new PathGuardError();
  return { type: file ? "file" : "directory", dev: stat.dev, ino: stat.ino };
}

function sameIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.type === right.type && left.dev === right.dev && left.ino === right.ino;
}

function isStableIdentityNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNotFound(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }

function isCanonicalWithin(candidate: string, root: string, platform: PathPlatform): boolean {
  try { return lexicalPathHandle(candidate, [root], platform).canonical.length > 0; } catch { return false; }
}
