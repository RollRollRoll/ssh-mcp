import { ErrorCodes } from "../errors/error-codes.js";
import { canonicalTarget, type RemoteSafePathHandle, type SftpPathPort, type SftpPathStat } from "./linux-path-guard.js";
import { PathGuardError, type LexicalPathHandle, lexicalPathHandle, pathSegments } from "./path-guard.js";
import type { WindowsReparseProbePort, WindowsReparseProbeResult } from "./windows-reparse-probe.js";

type SafePathKind = "file" | "directory";
interface ExistingEntry { readonly path: string; readonly canonical: string; readonly kind: SafePathKind; readonly id: string; }

/** Windows 远端以 SFTP 与固定 LiteralPath 探针双重确认，任一不确定即拒绝。 */
export class WindowsPathGuard {
  public constructor(
    private readonly roots: readonly string[],
    private readonly sftp: SftpPathPort,
    private readonly probe: WindowsReparseProbePort
  ) {}

  public lexical(requested: string): LexicalPathHandle { return lexicalPathHandle(requested, this.roots, "win32"); }

  public async verify(requested: string): Promise<RemoteSafePathHandle> {
    const lexical = this.lexical(requested);
    const preflight = await this.inspect(lexical);
    await this.verifyProbe(preflight);
    const canonical = canonicalTarget(lexical, preflight, "win32");
    return Object.freeze({
      ...lexical,
      canonical,
      revalidateBeforeOpen: async () => {
        const actual = await this.inspect(lexical);
        if (!sameEntries(actual, preflight)) throw new PathGuardError();
        await this.verifyProbe(actual);
      }
    });
  }

  private async inspect(lexical: LexicalPathHandle): Promise<readonly ExistingEntry[]> {
    const requestedSegments = pathSegments(lexical.canonical, "win32");
    const declaredRootSegments = pathSegments(lexical.root, "win32");
    const rootLength = declaredRootSegments.length;
    const segments = [...declaredRootSegments, ...requestedSegments.slice(rootLength)];
    const entries: ExistingEntry[] = [];
    for (let index = 0; index < segments.length; index += 1) {
      const candidate = `${segments[0]}${segments.slice(1, index + 1).join("\\")}`;
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
        try { lexicalPathHandle(canonical, [lexical.root], "win32"); } catch { throw new PathGuardError(); }
      }
      entries.push({ path: candidate, canonical, ...safeStatus });
    }
    if (entries.length === 0) throw new PathGuardError();
    return Object.freeze(entries);
  }

  private async verifyProbe(entries: readonly ExistingEntry[]): Promise<void> {
    let results: readonly WindowsReparseProbeResult[];
    try { results = await this.probe.probe(entries.map((entry) => entry.path)); } catch { throw new PathGuardError(); }
    if (!Array.isArray(results) || results.length !== entries.length) throw new PathGuardError();
    for (const [index, result] of results.entries()) {
      const entry = entries[index]!;
      if (!isProbeResult(result)) throw new PathGuardError();
      if (!result.exists) throw new PathGuardError();
      if (result.reparse) throw new PathGuardError(ErrorCodes.LINK_NOT_ALLOWED);
      try {
        const probeCanonical = lexicalPathHandle(result.fullName, [entry.canonical], "win32").canonical;
        const sftpCanonical = lexicalPathHandle(entry.canonical, [result.fullName], "win32").canonical;
        if (probeCanonical.length === 0 || sftpCanonical.length === 0) throw new Error("unreachable");
      } catch { throw new PathGuardError(); }
    }
  }
}

function sameEntries(left: readonly ExistingEntry[], right: readonly ExistingEntry[]): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const expected = right[index]!;
    return entry.path === expected.path && entry.canonical === expected.canonical && entry.kind === expected.kind && entry.id === expected.id;
  });
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

function isProbeResult(value: unknown): value is WindowsReparseProbeResult {
  if (typeof value !== "object" || value === null) return false;
  const { fullName, exists, reparse } = value as Record<string, unknown>;
  return typeof fullName === "string" && typeof exists === "boolean" && typeof reparse === "boolean";
}
