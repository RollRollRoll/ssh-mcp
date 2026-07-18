import { ErrorCodes } from "../errors/error-codes.js";
import { PathGuardError, type LexicalPathHandle, lexicalPathHandle, pathSegments } from "./path-guard.js";

export interface SftpPathStat {
  readonly kind: "file" | "directory" | "symlink";
  /** 由 SFTP 适配层从稳定对象属性提供；无法可靠提供时不得签发安全句柄。 */
  readonly id: string;
}

/** 仅暴露路径元数据端口；传输流由后续任务接入。 */
export interface SftpPathPort {
  lstat(path: string): Promise<SftpPathStat>;
  realpath(path: string): Promise<string>;
}

type SafePathKind = "file" | "directory";
interface ExistingEntry { readonly path: string; readonly canonical: string; readonly kind: SafePathKind; readonly id: string; }

export interface RemoteSafePathHandle extends LexicalPathHandle {
  revalidateBeforeOpen(): Promise<void>;
}

/** Linux 远端只使用 POSIX 语义，任何未知 SFTP 状态均拒绝。 */
export class LinuxPathGuard {
  public constructor(private readonly roots: readonly string[], private readonly sftp: SftpPathPort) {}

  public lexical(requested: string): LexicalPathHandle { return lexicalPathHandle(requested, this.roots, "posix"); }

  public async verify(requested: string): Promise<RemoteSafePathHandle> {
    const lexical = this.lexical(requested);
    const preflight = await this.inspect(lexical);
    const canonical = canonicalTarget(lexical, preflight, "posix");
    return Object.freeze({
      ...lexical,
      canonical,
      revalidateBeforeOpen: async () => { await this.revalidate(lexical, preflight); }
    });
  }

  private async revalidate(lexical: LexicalPathHandle, expected: readonly ExistingEntry[]): Promise<void> {
    const actual = await this.inspect(lexical);
    if (actual.length !== expected.length || actual.some((entry, index) => !sameEntry(entry, expected[index]!))) throw new PathGuardError();
  }

  private async inspect(lexical: LexicalPathHandle): Promise<readonly ExistingEntry[]> {
    const segments = pathSegments(lexical.canonical, "posix");
    const rootLength = pathSegments(lexical.root, "posix").length;
    const entries: ExistingEntry[] = [];
    for (let index = 0; index < segments.length; index += 1) {
      const candidate = `/${segments.slice(1, index + 1).join("/")}`;
      let status: SftpPathStat;
      try { status = await this.sftp.lstat(candidate); } catch (error: unknown) {
        if (!isNotFound(error) || index < rootLength - 1) throw new PathGuardError();
        break;
      }
      const safeStatus = checkedStatus(status);
      if (index < segments.length - 1 && safeStatus.kind !== "directory") throw new PathGuardError();
      let canonical: string;
      try { canonical = await this.sftp.realpath(candidate); } catch { throw new PathGuardError(); }
      if (index + 1 >= rootLength) {
        try { lexicalPathHandle(canonical, [lexical.root], "posix"); } catch { throw new PathGuardError(); }
      }
      entries.push({ path: candidate, canonical, ...safeStatus });
    }
    if (entries.length === 0) throw new PathGuardError();
    return Object.freeze(entries);
  }
}

export function canonicalTarget(lexical: LexicalPathHandle, entries: readonly { path: string; canonical: string }[], platform: "posix" | "win32"): string {
  const last = entries.at(-1)!;
  const separator = platform === "posix" ? "/" : "\\";
  const requestedSegments = pathSegments(lexical.canonical, platform);
  const existingSegments = pathSegments(last.path, platform);
  const tail = requestedSegments.slice(existingSegments.length);
  return tail.length === 0 ? last.canonical : `${last.canonical.replace(/[\\/]$/, "")}${separator}${tail.join(separator)}`;
}

function sameEntry(left: ExistingEntry, right: ExistingEntry): boolean {
  return left.path === right.path && left.canonical === right.canonical && left.kind === right.kind && left.id === right.id;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error
    && (error.code === "ENOENT" || error.code === 2 || error.code === "2");
}

function isStableIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && /^[A-Za-z0-9._:-]+$/.test(value);
}

function checkedStatus(status: unknown): { readonly kind: SafePathKind; readonly id: string } {
  if (typeof status !== "object" || status === null) throw new PathGuardError();
  const { kind, id } = status as Record<string, unknown>;
  if (kind === "symlink") throw new PathGuardError(ErrorCodes.LINK_NOT_ALLOWED);
  if ((kind !== "file" && kind !== "directory") || !isStableIdentity(id)) throw new PathGuardError();
  return { kind, id };
}
