import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApprovalExecution, ApprovalService } from "../approval/approval-service.js";
import { createOperationIntent, type OperationIntent } from "../approval/operation-intent.js";
import { ErrorCodes, createMcpOperationError, type McpOperationError } from "../errors/error-contract.js";
import { HostRegistry } from "../hosts/host-registry.js";
import { MultiHostCoordinator } from "../multihost/multi-host-coordinator.js";
import { isWithinRoot, lexicalPathHandle, PathGuardError, type PathPlatform } from "../paths/path-guard.js";
import type { TransferRequest, TransferService } from "../transfers/file-transfer.js";
import { OperationManagerError } from "../operations/operation-manager.js";

const CommonFields = {
  hosts: z.array(z.string().min(1)).min(1).max(10).refine((hosts) => new Set(hosts).size === hosts.length, "主机别名不可重复"),
  recursive: z.boolean(),
  overwrite: z.boolean(),
  executionMode: z.enum(["parallel", "sequential"])
};
const UploadInputSchema = z.object({
  ...CommonFields,
  localSource: z.string().min(1),
  remoteTarget: z.string().min(1)
}).strict();
const DownloadInputSchema = z.object({
  ...CommonFields,
  remoteSource: z.string().min(1),
  localTarget: z.string().min(1)
}).strict();
const ErrorSchema = z.object({
  code: z.string(), message: z.string(), finalState: z.enum(["failed", "timed_out", "partial_failure", "unknown"]),
  retriable: z.boolean(), sideEffects: z.enum(["none", "possible", "partial", "confirmed"]),
  operationId: z.string().optional(), host: z.string().optional(), sessionId: z.string().optional(), details: z.record(z.unknown()).optional()
}).strict();
const OutputSchema = z.object({
  operationId: z.string().optional(), state: z.literal("running").optional(), error: ErrorSchema.optional()
}).strict();

interface TransferApprovalPort {
  execute<T>(intent: OperationIntent, sideEffect: (approvedIntent: OperationIntent) => T | Promise<T>): Promise<ApprovalExecution<T>>;
}

export interface FileTransferToolDependencies {
  readonly registry: HostRegistry;
  readonly approval: TransferApprovalPort | ApprovalService;
  readonly transfer: Pick<TransferService, "start">;
  readonly localRoots: readonly string[];
  readonly localPlatform: PathPlatform;
  readonly coordinator?: MultiHostCoordinator;
}

export function registerFileTransferTools(server: McpServer, dependencies: FileTransferToolDependencies): void {
  server.registerTool("file_upload", {
    description: "经一次性审批后把本地普通文件或目录上传到 1–10 台登记主机",
    inputSchema: UploadInputSchema,
    outputSchema: OutputSchema
  }, async (input) => await executeTransfer(dependencies, "upload", input));

  server.registerTool("file_download", {
    description: "经一次性审批后从 1–10 台登记主机下载普通文件或目录",
    inputSchema: DownloadInputSchema,
    outputSchema: OutputSchema
  }, async (input) => await executeTransfer(dependencies, "download", input));
}

async function executeTransfer(
  dependencies: FileTransferToolDependencies,
  direction: "upload" | "download",
  input: z.infer<typeof UploadInputSchema> | z.infer<typeof DownloadInputSchema>
) {
  const resolvedHosts = input.hosts.map((alias) => dependencies.registry.get(alias));
  if (resolvedHosts.some((host) => host === undefined)) return errorResult(simpleError(ErrorCodes.HOST_NOT_REGISTERED));
  const hosts = resolvedHosts as NonNullable<(typeof resolvedHosts)[number]>[];

  const localPath = direction === "upload" ? (input as z.infer<typeof UploadInputSchema>).localSource : (input as z.infer<typeof DownloadInputSchema>).localTarget;
  const remotePath = direction === "upload" ? (input as z.infer<typeof UploadInputSchema>).remoteTarget : (input as z.infer<typeof DownloadInputSchema>).remoteSource;
  try {
    // 审批前只能做词法边界判断，绝不触发本地元数据、SFTP 或 Windows 探针。
    lexicalPathHandle(localPath, dependencies.localRoots, dependencies.localPlatform);
    for (const host of hosts) lexicalPathHandle(remotePath, host.remoteRoots, host.platform === "linux" ? "posix" : "win32");
    if (direction === "download" && hosts.length > 1) {
      downloadTargets(localPath, hosts.map((host) => host.alias), dependencies.localRoots, dependencies.localPlatform);
    }
  } catch (error: unknown) {
    if (error instanceof PathGuardError) return errorResult(simpleError(error.code));
    throw error;
  }

  const payload: Readonly<Record<string, string | boolean>> = direction === "upload"
    ? { localSource: localPath, remoteTarget: remotePath, recursive: input.recursive, overwrite: input.overwrite }
    : { remoteSource: remotePath, localTarget: localPath, recursive: input.recursive, overwrite: input.overwrite };
  const expected = createOperationIntent({
    kind: direction, hosts: input.hosts, platformByHost: Object.fromEntries(hosts.map((host) => [host.alias, host.platform])), payload,
    executionMode: input.executionMode
  });
  const approval = await dependencies.approval.execute(expected, (approved) => {
    if (!sameIntent(expected, approved)) throw new IntentMismatchError();
    const requests = requestsFromApprovedIntent(dependencies, approved);
    if (requests.length === 1) return dependencies.transfer.start(requests[0]!);
    if (dependencies.coordinator === undefined) throw new Error("多主机协调器不可用");
    return dependencies.coordinator.start({
      hosts: requests.map((request) => request.host), executionMode: approved.executionMode!, timeoutKind: "transfer",
      failureCode: ErrorCodes.TRANSFER_FAILED, timeoutCode: ErrorCodes.TRANSFER_TIMEOUT,
      start: (host) => dependencies.transfer.start(requests.find((request) => request.host.alias === host.alias)!)
    });
  }).catch((error: unknown) => {
    if (error instanceof IntentMismatchError) return { approved: false as const, error: simpleError(ErrorCodes.APPROVAL_INTENT_MISMATCH) };
    if (error instanceof OperationManagerError) return { approved: false as const, error: error.error };
    if (error instanceof PathGuardError) return { approved: false as const, error: simpleError(error.code) };
    if (error instanceof Error && "code" in error && typeof error.code === "string" && Object.values(ErrorCodes).includes(error.code as never)) {
      return { approved: false as const, error: simpleError(error.code as McpOperationError["code"]) };
    }
    throw error;
  });
  if (!approval.approved) return errorResult(approval.error);
  return successResult(approval.value);
}

class IntentMismatchError extends Error {}

function requestsFromApprovedIntent(
  dependencies: FileTransferToolDependencies,
  approved: OperationIntent
): readonly TransferRequest[] {
  const direction = approved.kind;
  const recursive = approved.payload.recursive;
  const overwrite = approved.payload.overwrite;
  if ((direction !== "upload" && direction !== "download") || approved.hosts.length < 1 || approved.hosts.length > 10
    || (approved.executionMode !== "parallel" && approved.executionMode !== "sequential")
    || typeof recursive !== "boolean" || typeof overwrite !== "boolean") {
    throw new IntentMismatchError();
  }
  if (Object.keys(approved.platformByHost).length !== approved.hosts.length) {
    throw new IntentMismatchError();
  }
  const source = approved.kind === "upload" ? approved.payload.localSource : approved.payload.remoteSource;
  const target = approved.kind === "upload" ? approved.payload.remoteTarget : approved.payload.localTarget;
  if (typeof source !== "string" || typeof target !== "string") throw new IntentMismatchError();
  const targets = direction === "download" && approved.hosts.length > 1
    ? downloadTargets(target, approved.hosts, dependencies.localRoots, dependencies.localPlatform)
    : undefined;
  return approved.hosts.map((alias) => {
    const approvedHost = dependencies.registry.get(alias);
    if (approvedHost === undefined || approved.platformByHost[alias] !== approvedHost.platform) throw new IntentMismatchError();
    const localPath = direction === "upload" ? source : target;
    const remotePath = direction === "upload" ? target : source;
    const perHostTarget = targets?.get(alias) ?? localPath;
    try {
      lexicalPathHandle(perHostTarget, dependencies.localRoots, dependencies.localPlatform);
      lexicalPathHandle(remotePath, approvedHost.remoteRoots, approvedHost.platform === "linux" ? "posix" : "win32");
    } catch {
      throw new IntentMismatchError();
    }
    return Object.freeze({
      direction,
      host: approvedHost,
      source,
      target: direction === "download" ? perHostTarget : target,
      overwrite,
      recursive
    });
  });
}

/** 审批前纯词法地派生多主机下载目标，拒绝任何平台等价或重叠目录。 */
function downloadTargets(
  root: string,
  aliases: readonly string[],
  localRoots: readonly string[],
  platform: PathPlatform
): ReadonlyMap<string, string> {
  const derived = aliases.map((alias) => {
    assertSafeAliasSegment(alias, platform);
    const handle = lexicalPathHandle(joinLocalTarget(root, alias, platform), localRoots, platform);
    return Object.freeze({ alias, canonical: handle.canonical });
  });
  for (let left = 0; left < derived.length; left += 1) {
    for (let right = left + 1; right < derived.length; right += 1) {
      const first = derived[left]!;
      const second = derived[right]!;
      if (samePlatformPath(first.canonical, second.canonical, platform)
        || isWithinRoot(first.canonical, second.canonical, platform)
        || isWithinRoot(second.canonical, first.canonical, platform)) {
        throw new PathGuardError();
      }
    }
  }
  return new Map(derived.map(({ alias, canonical }) => [alias, canonical]));
}

function assertSafeAliasSegment(alias: string, platform: PathPlatform): void {
  // 先执行跨平台的便携单段校验；随后才应用 Windows 专属字符限制。
  if (alias.length === 0 || alias === "." || alias === ".." || /[\\/]/u.test(alias)
    || /^[A-Za-z]:/u.test(alias) || /\p{Cc}/u.test(alias) || /[. ]$/u.test(alias) || isWindowsDeviceAlias(alias)) {
    throw new PathGuardError();
  }
  if (platform === "win32" && /[<>:"|?*]/u.test(alias)) throw new PathGuardError();
}

function isWindowsDeviceAlias(alias: string): boolean {
  const withoutTrailingDotsAndSpaces = alias.replace(/[. ]+$/u, "");
  const baseName = withoutTrailingDotsAndSpaces.split(".", 1)[0]?.replace(/[ ]+$/u, "") ?? "";
  return /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/iu.test(baseName);
}

function samePlatformPath(left: string, right: string, platform: PathPlatform): boolean {
  return platform === "win32"
    ? left.toLocaleUpperCase("en-US") === right.toLocaleUpperCase("en-US")
    : left === right;
}

function joinLocalTarget(root: string, alias: string, platform: PathPlatform): string {
  const separator = platform === "posix" ? "/" : "\\";
  return `${root.endsWith(separator) ? root.slice(0, -1) : root}${separator}${alias}`;
}

function sameIntent(expected: OperationIntent, approved: OperationIntent): boolean {
  return expected.kind === approved.kind && expected.digest === approved.digest && expected.canonicalJson === approved.canonicalJson;
}
function simpleError(code: McpOperationError["code"]): McpOperationError {
  return createMcpOperationError({ code, message: code, finalState: "failed", retriable: false, sideEffects: "none" });
}
function successResult(snapshot: { operationId: string; state: string }) {
  const structuredContent = { operationId: snapshot.operationId, state: "running" as const };
  return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
}
function errorResult(error: McpOperationError) {
  const structuredContent = { error };
  return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent, isError: true as const };
}
