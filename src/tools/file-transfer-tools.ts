import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApprovalExecution, ApprovalService } from "../approval/approval-service.js";
import { createOperationIntent, type OperationIntent } from "../approval/operation-intent.js";
import { ErrorCodes, createMcpOperationError, type McpOperationError } from "../errors/error-contract.js";
import { HostRegistry } from "../hosts/host-registry.js";
import { lexicalPathHandle, PathGuardError, type PathPlatform } from "../paths/path-guard.js";
import type { TransferRequest, TransferService } from "../transfers/file-transfer.js";
import { OperationManagerError } from "../operations/operation-manager.js";

const CommonFields = {
  hosts: z.array(z.string().min(1)).length(1).refine((hosts) => new Set(hosts).size === hosts.length, "主机别名不可重复"),
  recursive: z.literal(false),
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
}

export function registerFileTransferTools(server: McpServer, dependencies: FileTransferToolDependencies): void {
  server.registerTool("file_upload", {
    description: "经一次性审批后把一个本地普通文件流式上传到一台登记主机",
    inputSchema: UploadInputSchema,
    outputSchema: OutputSchema
  }, async (input) => await executeTransfer(dependencies, "upload", input));

  server.registerTool("file_download", {
    description: "经一次性审批后从一台登记主机流式下载一个普通文件",
    inputSchema: DownloadInputSchema,
    outputSchema: OutputSchema
  }, async (input) => await executeTransfer(dependencies, "download", input));
}

async function executeTransfer(
  dependencies: FileTransferToolDependencies,
  direction: "upload" | "download",
  input: z.infer<typeof UploadInputSchema> | z.infer<typeof DownloadInputSchema>
) {
  const host = dependencies.registry.get(input.hosts[0]!);
  if (host === undefined) return errorResult(simpleError(ErrorCodes.HOST_NOT_REGISTERED));

  const localPath = direction === "upload" ? (input as z.infer<typeof UploadInputSchema>).localSource : (input as z.infer<typeof DownloadInputSchema>).localTarget;
  const remotePath = direction === "upload" ? (input as z.infer<typeof UploadInputSchema>).remoteTarget : (input as z.infer<typeof DownloadInputSchema>).remoteSource;
  try {
    // 审批前只能做词法边界判断，绝不触发本地元数据、SFTP 或 Windows 探针。
    lexicalPathHandle(localPath, dependencies.localRoots, dependencies.localPlatform);
    lexicalPathHandle(remotePath, host.remoteRoots, host.platform === "linux" ? "posix" : "win32");
  } catch (error: unknown) {
    if (error instanceof PathGuardError) return errorResult(simpleError(error.code));
    throw error;
  }

  const payload: Readonly<Record<string, string | boolean>> = direction === "upload"
    ? { localSource: localPath, remoteTarget: remotePath, recursive: false, overwrite: input.overwrite }
    : { remoteSource: remotePath, localTarget: localPath, recursive: false, overwrite: input.overwrite };
  const expected = createOperationIntent({
    kind: direction, hosts: input.hosts, platformByHost: { [host.alias]: host.platform }, payload,
    executionMode: input.executionMode
  });
  const approval = await dependencies.approval.execute(expected, (approved) => {
    if (!sameIntent(expected, approved)) throw new IntentMismatchError();
    return dependencies.transfer.start(requestFromApprovedIntent(dependencies, approved));
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

function requestFromApprovedIntent(
  dependencies: FileTransferToolDependencies,
  approved: OperationIntent
): TransferRequest {
  if ((approved.kind !== "upload" && approved.kind !== "download") || approved.hosts.length !== 1
    || (approved.executionMode !== "parallel" && approved.executionMode !== "sequential")) {
    throw new IntentMismatchError();
  }
  const alias = approved.hosts[0]!;
  const approvedHost = dependencies.registry.get(alias);
  if (approvedHost === undefined || approved.platformByHost[alias] !== approvedHost.platform
    || Object.keys(approved.platformByHost).length !== 1 || approved.payload.recursive !== false
    || typeof approved.payload.overwrite !== "boolean") {
    throw new IntentMismatchError();
  }
  const source = approved.kind === "upload" ? approved.payload.localSource : approved.payload.remoteSource;
  const target = approved.kind === "upload" ? approved.payload.remoteTarget : approved.payload.localTarget;
  if (typeof source !== "string" || typeof target !== "string") throw new IntentMismatchError();
  const localPath = approved.kind === "upload" ? source : target;
  const remotePath = approved.kind === "upload" ? target : source;
  try {
    lexicalPathHandle(localPath, dependencies.localRoots, dependencies.localPlatform);
    lexicalPathHandle(remotePath, approvedHost.remoteRoots, approvedHost.platform === "linux" ? "posix" : "win32");
  } catch {
    throw new IntentMismatchError();
  }
  return {
    direction: approved.kind,
    host: approvedHost,
    source,
    target,
    overwrite: approved.payload.overwrite
  };
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
