import path from "node:path";
import { ErrorCodes, type ErrorCode } from "../errors/error-codes.js";
import type { PathPlatform } from "../paths/path-guard.js";

export type DirectoryEntryKind = "file" | "directory";

export interface DirectoryWalkStat {
  readonly kind: DirectoryEntryKind | "symlink" | "unknown";
  readonly size: number;
  readonly id: string;
  /** 平台已证明该路径是否为挂载边界；无法证明时必须为 unknown。 */
  readonly mountPoint: boolean | "unknown";
}

export interface DirectoryWalkPort {
  inspect(path: string): Promise<DirectoryWalkStat>;
  list(path: string): Promise<readonly string[]>;
}

export interface DirectoryWalkEntry {
  readonly relativePath: string;
  readonly kind: DirectoryEntryKind;
  readonly size: number;
  readonly id: string;
}

export class DirectoryWalkError extends Error {
  public constructor(public readonly code: ErrorCode) {
    super(code);
    this.name = "DirectoryWalkError";
  }
}

/** 只枚举能证明身份的真实目录与普通文件，绝不读取或跟随链接。 */
export class DirectoryWalker {
  private readonly library: typeof path.posix;

  public constructor(private readonly port: DirectoryWalkPort, private readonly platform: PathPlatform) {
    this.library = platform === "posix" ? path.posix : path.win32;
  }

  public async walk(root: string): Promise<readonly DirectoryWalkEntry[]> {
    const rootStat = checkedStat(await this.port.inspect(root));
    if (rootStat.kind !== "directory") throw new DirectoryWalkError(ErrorCodes.PATH_DENIED);
    const entries: DirectoryWalkEntry[] = [];
    await this.walkDirectory(root, "", entries);
    entries.sort((left, right) => codePointCompare(left.relativePath, right.relativePath));
    return Object.freeze(entries.map((entry) => Object.freeze(entry)));
  }

  private async walkDirectory(absolute: string, relative: string, entries: DirectoryWalkEntry[]): Promise<void> {
    const names = await this.port.list(absolute);
    if (!Array.isArray(names)) throw new DirectoryWalkError(ErrorCodes.PATH_DENIED);
    const unique = new Set<string>();
    for (const name of names) {
      validateName(name, this.platform);
      if (unique.has(name)) throw new DirectoryWalkError(ErrorCodes.PATH_DENIED);
      unique.add(name);
    }
    const sorted = [...unique].sort(codePointCompare);
    for (const name of sorted) {
      const childRelative = relative === "" ? name : `${relative}/${name}`;
      validateRelativePath(childRelative);
      const absoluteChild = this.library.join(absolute, ...childRelative.split("/").slice(relative === "" ? 0 : relative.split("/").length));
      const stat = checkedStat(await this.port.inspect(absoluteChild));
      const entry = Object.freeze({ relativePath: childRelative, kind: stat.kind, size: stat.size, id: stat.id });
      entries.push(entry);
      if (stat.kind === "directory") await this.walkDirectory(absoluteChild, childRelative, entries);
    }
  }
}

function checkedStat(value: unknown): { readonly kind: DirectoryEntryKind; readonly size: number; readonly id: string } {
  if (typeof value !== "object" || value === null) throw new DirectoryWalkError(ErrorCodes.PATH_DENIED);
  const { kind, size, id, mountPoint } = value as Record<string, unknown>;
  if (kind === "symlink") throw new DirectoryWalkError(ErrorCodes.LINK_NOT_ALLOWED);
  if ((kind !== "file" && kind !== "directory") || !Number.isSafeInteger(size) || (size as number) < 0
    || typeof id !== "string" || id.length === 0 || id.length > 512
    || (mountPoint !== true && mountPoint !== false && mountPoint !== "unknown")
    || mountPoint === "unknown" || mountPoint === true) {
    throw new DirectoryWalkError(ErrorCodes.PATH_DENIED);
  }
  return { kind, size: size as number, id };
}

function validateName(name: unknown, platform: PathPlatform): asserts name is string {
  if (typeof name !== "string" || name.length === 0 || name === "." || name === ".." || name.includes("\0")
    || name.includes("/") || (platform === "win32" && name.includes("\\"))) {
    throw new DirectoryWalkError(ErrorCodes.PATH_DENIED);
  }
}

export function validateRelativePath(relativePath: string): void {
  if (relativePath.length === 0 || relativePath.includes("\0") || relativePath.startsWith("/")
    || /^[A-Za-z]:[\\/]/.test(relativePath)) throw new DirectoryWalkError(ErrorCodes.PATH_DENIED);
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || segment.includes("\\"))) {
    throw new DirectoryWalkError(ErrorCodes.PATH_DENIED);
  }
}

function codePointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
