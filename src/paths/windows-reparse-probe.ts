import { ErrorCodes } from "../errors/error-codes.js";
import { PathGuardError } from "./path-guard.js";

export interface WindowsReparseProbeResult {
  readonly fullName: string;
  readonly exists: boolean;
  readonly reparse: boolean;
}

export interface WindowsReparseProbePort {
  probe(paths: readonly string[]): Promise<readonly WindowsReparseProbeResult[]>;
}

export interface WindowsReparseCommandExecutor {
  execute(command: string): Promise<{ readonly stdout: string; readonly stderr: string; readonly code: number }>;
}

const FIXED_PROGRAM = [
  "$paths = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) | ConvertFrom-Json -ErrorAction Stop",
  "$result = @()",
  "foreach ($requestedPath in $paths) {",
  "  $item = Get-Item -LiteralPath $requestedPath -Force -ErrorAction Stop",
  "  $result += @{ fullName = [string]$item.FullName; exists = $true; reparse = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint) }",
  "}",
  "[Console]::Out.Write((ConvertTo-Json -InputObject @($result) -Compress))"
].join("\n");

export const MAX_WINDOWS_REPARSE_PROBE_PATHS = 64;
export const MAX_WINDOWS_REPARSE_PROBE_PATH_LENGTH = 4096;
export const MAX_WINDOWS_REPARSE_PROBE_STDOUT_BYTES = MAX_WINDOWS_REPARSE_PROBE_PATHS * (MAX_WINDOWS_REPARSE_PROBE_PATH_LENGTH + 128);

/** 返回的命令仅由固定程序及 base64 JSON 数据组成，路径绝不作为 PowerShell 片段插入。 */
export function buildWindowsReparseProbeCommand(paths: readonly string[], executable = "powershell.exe"): string {
  assertValidProbeRequest(paths);
  const payload = Buffer.from(JSON.stringify(paths), "utf8").toString("base64");
  const program = `$payload = '${payload}'\n${FIXED_PROGRAM}`;
  return `${quoteExecutable(executable)} -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(program, "utf16le").toString("base64")}`;
}

export function parseWindowsReparseProbeOutput(output: string, expectedCount: number): readonly WindowsReparseProbeResult[] {
  try {
    if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > MAX_WINDOWS_REPARSE_PROBE_PATHS) throw new Error("invalid expected count");
    if (Buffer.byteLength(output, "utf8") > MAX_WINDOWS_REPARSE_PROBE_STDOUT_BYTES) throw new Error("output too large");
    const parsed: unknown = JSON.parse(output);
    if (!Array.isArray(parsed) || parsed.length !== expectedCount || parsed.length > MAX_WINDOWS_REPARSE_PROBE_PATHS) throw new Error("invalid count");
    const values = parsed;
    const results = values.map((value): WindowsReparseProbeResult => {
      if (value === null || typeof value !== "object") throw new Error("invalid");
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record);
      if (keys.length !== 3 || !keys.every((key) => key === "fullName" || key === "exists" || key === "reparse")) throw new Error("invalid");
      if (typeof record.fullName !== "string" || record.fullName.length === 0 || record.fullName.length > MAX_WINDOWS_REPARSE_PROBE_PATH_LENGTH || typeof record.exists !== "boolean" || typeof record.reparse !== "boolean") throw new Error("invalid");
      return Object.freeze({ fullName: record.fullName, exists: record.exists, reparse: record.reparse });
    });
    return Object.freeze(results);
  } catch { throw new PathGuardError(ErrorCodes.PATH_DENIED); }
}

/** 将固定探针的传输与解析封装为可注入端口，调用方不得拼接用户 PowerShell。 */
export class WindowsReparseProbe implements WindowsReparseProbePort {
  public constructor(private readonly executor: WindowsReparseCommandExecutor, private readonly executable = "powershell.exe") {}

  public async probe(paths: readonly string[]): Promise<readonly WindowsReparseProbeResult[]> {
    try {
      assertValidProbeRequest(paths);
      const result = await this.executor.execute(buildWindowsReparseProbeCommand(paths, this.executable));
      if (result.code !== 0 || result.stderr !== "") throw new Error("probe failed");
      return parseWindowsReparseProbeOutput(result.stdout, paths.length);
    } catch (error: unknown) {
      if (error instanceof PathGuardError) throw error;
      throw new PathGuardError(ErrorCodes.PATH_DENIED);
    }
  }
}

function assertValidProbeRequest(paths: readonly string[]): void {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > MAX_WINDOWS_REPARSE_PROBE_PATHS
    || paths.some((path) => typeof path !== "string" || path.length === 0 || path.length > MAX_WINDOWS_REPARSE_PROBE_PATH_LENGTH)) {
    throw new PathGuardError(ErrorCodes.PATH_DENIED);
  }
}

function quoteExecutable(value: string): string { return `"${value.replace(/"/g, '""')}"`; }
