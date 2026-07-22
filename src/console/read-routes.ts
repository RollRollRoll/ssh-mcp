import type { IncomingMessage, ServerResponse } from "node:http";
import { ErrorCodes } from "../errors/error-codes.js";
import { OperationManager, OperationManagerError } from "../operations/operation-manager.js";
import { ConsoleHttpError, CONSOLE_SECURITY_HEADERS } from "./http-errors.js";
import { RuntimeRevisionHub } from "./runtime-revision-hub.js";
import { RuntimeSnapshotProjector } from "./runtime-snapshot-projector.js";

const MAX_SSE_CLIENTS = 16;
const outputPath = /^\/api\/v1\/operations\/([A-Za-z0-9-]{1,128})\/output(?:\?(.*))?$/;

/** 只读控制台 API；输出沿用 OperationManager cursor，SSE 只发送失效修订号。 */
export class ConsoleReadRoutes {
  private readonly eventStreams = new Map<ServerResponse, () => void>();
  private closed = false;

  public constructor(
    private readonly projector: RuntimeSnapshotProjector,
    private readonly revisions: RuntimeRevisionHub,
    private readonly operations: OperationManager
  ) {}

  public handle(request: IncomingMessage, response: ServerResponse): boolean {
    if (request.method !== "GET" || request.url === undefined) return false;
    if (request.url === "/api/v1/snapshot") {
      this.json(response, this.projector.snapshot());
      return true;
    }
    if (request.url === "/api/v1/events") {
      this.openEvents(request, response);
      return true;
    }
    const match = outputPath.exec(request.url);
    if (match !== null) {
      this.output(response, match[1]!, match[2]);
      return true;
    }
    return false;
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [response, unsubscribe] of [...this.eventStreams]) {
      unsubscribe();
      response.write("event: offline\ndata: {}\n\n");
      response.end();
    }
    this.eventStreams.clear();
  }

  /** 仅供资源上限测试观测，不暴露响应对象。 */
  public activeEventStreamCount(): number {
    return this.eventStreams.size;
  }

  private openEvents(request: IncomingMessage, response: ServerResponse): void {
    if (this.closed) throw new ConsoleHttpError(503, "RESOURCE_LIMIT");
    if (this.eventStreams.size >= MAX_SSE_CLIENTS) throw new ConsoleHttpError(429, "RESOURCE_LIMIT");
    response.writeHead(200, {
      ...CONSOLE_SECURITY_HEADERS,
      "content-type": "text/event-stream; charset=utf-8",
      connection: "keep-alive"
    });
    response.write(`event: ready\ndata: ${JSON.stringify({ revision: this.revisions.revision })}\n\n`);
    const unsubscribe = this.revisions.subscribe((event) => {
      response.write(`event: invalidated\ndata: ${JSON.stringify(event)}\n\n`);
    });
    this.eventStreams.set(response, unsubscribe);
    const release = (): void => {
      const current = this.eventStreams.get(response);
      if (current === undefined) return;
      this.eventStreams.delete(response);
      current();
    };
    request.once("close", release);
    response.once("close", release);
  }

  private output(response: ServerResponse, operationId: string, rawQuery: string | undefined): void {
    const query = new URLSearchParams(rawQuery ?? "");
    if ([...query.keys()].some((key) => key !== "cursor" && key !== "maxBytes")
      || query.getAll("cursor").length > 1 || query.getAll("maxBytes").length > 1) {
      throw new ConsoleHttpError(400, "INVALID_REQUEST");
    }
    const cursor = parseSafeInteger(query.get("cursor"), 0, "INVALID_CURSOR");
    const maxBytes = parseSafeInteger(query.get("maxBytes"), 64 * 1024, "INVALID_REQUEST");
    try {
      const result = this.operations.get(operationId, cursor, maxBytes);
      this.json(response, {
        frames: result.frames,
        nextCursor: result.nextCursor,
        minCursor: result.minCursor,
        truncated: result.truncated,
        droppedBytes: result.droppedBytes
      });
    } catch (error: unknown) {
      if (!(error instanceof OperationManagerError)) throw error;
      if (error.code === ErrorCodes.OPERATION_NOT_FOUND) throw new ConsoleHttpError(404, "OPERATION_NOT_FOUND");
      if (error.code === ErrorCodes.OPERATION_EXPIRED) throw new ConsoleHttpError(410, "OPERATION_EXPIRED");
      if (error.code === ErrorCodes.INVALID_CURSOR || error.code === ErrorCodes.INVALID_ARGUMENT) {
        throw new ConsoleHttpError(400,
          error.code === ErrorCodes.INVALID_CURSOR ? "INVALID_CURSOR" : "INVALID_REQUEST");
      }
      throw error;
    }
  }

  private json(response: ServerResponse, value: unknown): void {
    const body = Buffer.from(JSON.stringify(value), "utf8");
    response.writeHead(200, {
      ...CONSOLE_SECURITY_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "content-length": String(body.length)
    });
    response.end(body);
  }
}

function parseSafeInteger(
  value: string | null,
  fallback: number,
  code: "INVALID_CURSOR" | "INVALID_REQUEST"
): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) throw new ConsoleHttpError(400, code);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new ConsoleHttpError(400, code);
  return number;
}
