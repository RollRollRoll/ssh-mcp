import path from "node:path";
import { ErrorCodes } from "../errors/error-codes.js";

export type PathPlatform = "posix" | "win32";

export class PathGuardError extends Error {
  public constructor(public readonly code: typeof ErrorCodes.PATH_DENIED | typeof ErrorCodes.LINK_NOT_ALLOWED = ErrorCodes.PATH_DENIED) {
    super(code);
    this.name = "PathGuardError";
  }
}

export interface LexicalPathHandle {
  readonly requested: string;
  readonly canonical: string;
  readonly root: string;
  readonly platform: PathPlatform;
}

/** 仅作字符串边界判断，不触碰文件系统、SFTP 或远程命令。 */
export function lexicalPathHandle(
  requested: string,
  roots: readonly string[],
  platform: PathPlatform,
  onIoAttempt?: () => void
): LexicalPathHandle {
  // 保留该钩子只用于测试显式证明本函数从不发起 I/O；实现绝不调用它。
  void onIoAttempt;
  const library = platform === "posix" ? path.posix : path.win32;
  if (!isAcceptedSyntax(requested, platform) || hasForbiddenSegment(requested, platform)) throw new PathGuardError();
  const canonical = library.normalize(requested);
  if (!library.isAbsolute(canonical) || !isAcceptedSyntax(canonical, platform)) throw new PathGuardError();
  const matchingRoots = roots.filter((root) => {
    if (!isAcceptedSyntax(root, platform) || hasForbiddenSegment(root, platform)) return false;
    const normalizedRoot = library.normalize(root);
    return library.isAbsolute(normalizedRoot) && isWithinRoot(canonical, normalizedRoot, platform);
  });
  if (matchingRoots.length !== 1) throw new PathGuardError();
  const root = library.normalize(matchingRoots[0]!);
  return Object.freeze({ requested, canonical, root, platform });
}

export function isWithinRoot(candidate: string, root: string, platform: PathPlatform): boolean {
  const library = platform === "posix" ? path.posix : path.win32;
  const normalizedCandidate = library.normalize(candidate);
  const normalizedRoot = library.normalize(root);
  if (platform === "win32") {
    const candidateParts = splitWindows(normalizedCandidate);
    const rootParts = splitWindows(normalizedRoot);
    return rootParts.length <= candidateParts.length && rootParts.every((part, index) => part === candidateParts[index]);
  }
  const candidateParts = normalizedCandidate.split("/").filter(Boolean);
  const rootParts = normalizedRoot.split("/").filter(Boolean);
  return rootParts.length <= candidateParts.length && rootParts.every((part, index) => part === candidateParts[index]);
}

export function pathSegments(value: string, platform: PathPlatform): readonly string[] {
  const library = platform === "posix" ? path.posix : path.win32;
  const normalized = library.normalize(value);
  if (platform === "win32") {
    const parsed = path.win32.parse(normalized);
    const segments = normalized.slice(parsed.root.length).split("\\").filter(Boolean);
    return Object.freeze([parsed.root, ...segments]);
  }
  return Object.freeze(["/", ...normalized.split("/").filter(Boolean)]);
}

export function joinSegments(segments: readonly string[], platform: PathPlatform): string {
  if (platform === "posix") return path.posix.join(...segments);
  return path.win32.join(...segments);
}

function isAcceptedSyntax(value: string, platform: PathPlatform): boolean {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return false;
  if (platform === "posix") return path.posix.isAbsolute(value) && !/^[A-Za-z]:[\\/]/.test(value) && !value.includes("\\");
  return path.win32.isAbsolute(value)
    && (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value))
    && !value.startsWith("/");
}

function hasForbiddenSegment(value: string, platform: PathPlatform): boolean {
  const separator = platform === "posix" ? /\/+/ : /[\\/]+/;
  return value.split(separator).includes("..");
}

function splitWindows(value: string): readonly string[] {
  const parsed = path.win32.parse(value);
  return [parsed.root.toLocaleLowerCase("en-US"), ...value.slice(parsed.root.length)
    .split("\\")
    .filter(Boolean)
    .map((part) => part.toLocaleLowerCase("en-US"))];
}
