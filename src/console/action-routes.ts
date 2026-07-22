import { z } from "zod";
import type { ApprovalCoordinator, ApprovalSafeSnapshot } from "../approval/approval-coordinator.js";
import {
  ApplicationServiceError,
  type CommandApplicationService,
  type CommandPreview
} from "../application/command-application-service.js";
import type { ProfileApplicationService, ProfilePreview } from "../application/profile-application-service.js";
import { ErrorCodes } from "../errors/error-codes.js";
import { OperationManagerError } from "../operations/operation-manager.js";
import { ConsoleHttpError } from "./http-errors.js";

const boundedText = z.string().min(1).max(12 * 1024);
const CommandPreviewSchema = z.object({ host: boundedText, command: boundedText }).strict();
const ParameterValueSchema = z.union([z.string().max(12 * 1024), z.number().int().safe(), z.boolean()]);
const ProfilePreviewSchema = z.object({
  host: boundedText,
  profileId: boundedText,
  parameters: z.record(ParameterValueSchema)
}).strict();
const DecisionSchema = z.object({
  action: z.enum(["accept", "decline", "cancel"]),
  expectedDigest: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
const decisionPath = /^\/api\/v1\/approvals\/([A-Za-z0-9-]{1,128})\/decision$/;

export interface ConsoleActionResponse {
  readonly status: number;
  readonly body: unknown;
}

/** 网页命令/Profile 只创建冻结单主机预览；决定仍由统一审批协调器同步仲裁。 */
export class ConsoleActionRoutes {
  public constructor(
    private readonly commands: Pick<CommandApplicationService, "preview">,
    private readonly profiles: Pick<ProfileApplicationService, "preview">,
    private readonly approvals: ApprovalCoordinator
  ) {}

  public matches(method: string | undefined, path: string | undefined): boolean {
    if (method !== "POST" || path === undefined) return false;
    return path === "/api/v1/previews/command" || path === "/api/v1/previews/profile"
      || decisionPath.test(path);
  }

  public handle(path: string, body: unknown): ConsoleActionResponse {
    try {
      if (path === "/api/v1/previews/command") {
        const input = parse(CommandPreviewSchema, body);
        return { status: 201, body: projectPreview(this.commands.preview(input)) };
      }
      if (path === "/api/v1/previews/profile") {
        const input = parse(ProfilePreviewSchema, body);
        return { status: 201, body: projectPreview(this.profiles.preview(input)) };
      }
      const match = decisionPath.exec(path);
      if (match === null) throw new ConsoleHttpError(404, "NOT_FOUND");
      const input = parse(DecisionSchema, body);
      const approval = this.approvals.get(match[1]!);
      if (approval === undefined) throw new ConsoleHttpError(404, "APPROVAL_NOT_FOUND");
      if (approval.digest !== input.expectedDigest) {
        throw new ConsoleHttpError(409, "APPROVAL_INTENT_MISMATCH");
      }
      const resolution = this.approvals.decide(approval.approvalId, input.action);
      if (resolution.status !== "resolved") {
        throw new ConsoleHttpError(
          resolution.status === "not_found" ? 404 : 409,
          resolution.status === "not_found" ? "APPROVAL_NOT_FOUND" : "APPROVAL_ALREADY_RESOLVED"
        );
      }
      return { status: 200, body: { status: "resolved", approval: projectApproval(resolution.approval) } };
    } catch (error: unknown) {
      if (error instanceof ConsoleHttpError) throw error;
      if (error instanceof ApplicationServiceError) throw applicationHttpError(error);
      if (error instanceof OperationManagerError) {
        throw new ConsoleHttpError(error.code === ErrorCodes.RESOURCE_LIMIT ? 429 : 400,
          error.code === ErrorCodes.RESOURCE_LIMIT ? "RESOURCE_LIMIT" : "INVALID_REQUEST");
      }
      throw error;
    }
  }
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ConsoleHttpError(400, "INVALID_REQUEST");
  return parsed.data;
}

function projectPreview(preview: CommandPreview | ProfilePreview): Readonly<Record<string, unknown>> {
  return Object.freeze({
    approvalId: preview.approvalId,
    ...(preview.operationId === undefined ? {} : { operationId: preview.operationId }),
    intent: Object.freeze({
      kind: preview.intent.kind,
      hosts: preview.intent.hosts,
      platformByHost: preview.intent.platformByHost,
      payload: preview.intent.payload,
      ...(preview.intent.executionMode === undefined ? {} : { executionMode: preview.intent.executionMode }),
      canonicalJson: preview.intent.canonicalJson
    }),
    impact: preview.approval.safeView.impact,
    digest: preview.intent.digest,
    expiresAt: preview.approval.expiresAt
  });
}

function projectApproval(approval: ApprovalSafeSnapshot): Readonly<Record<string, unknown>> {
  return Object.freeze({
    approvalId: approval.approvalId,
    ...(approval.operationId === undefined ? {} : { operationId: approval.operationId }),
    revision: approval.revision,
    route: approval.route,
    state: approval.state,
    digest: approval.digest,
    ...(approval.resolvedAt === undefined ? {} : { resolvedAt: approval.resolvedAt }),
    ...(approval.resolvedBy === undefined ? {} : { resolvedBy: approval.resolvedBy }),
    ...(approval.errorCode === undefined ? {} : { errorCode: approval.errorCode })
  });
}

function applicationHttpError(error: ApplicationServiceError): ConsoleHttpError {
  if (error.error.code === ErrorCodes.HOST_NOT_REGISTERED || error.error.code === ErrorCodes.POLICY_NOT_FOUND) {
    return new ConsoleHttpError(404,
      error.error.code === ErrorCodes.HOST_NOT_REGISTERED ? "HOST_NOT_REGISTERED" : "POLICY_NOT_FOUND");
  }
  if (error.error.code === ErrorCodes.RESOURCE_LIMIT) return new ConsoleHttpError(429, "RESOURCE_LIMIT");
  if (error.error.code === ErrorCodes.POLICY_REQUIRES_APPROVAL) {
    return new ConsoleHttpError(400, "POLICY_NOT_APPLICABLE");
  }
  return new ConsoleHttpError(400, "INVALID_REQUEST");
}
