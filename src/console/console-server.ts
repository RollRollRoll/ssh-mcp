import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { ConsoleAuthGuard } from "./console-auth-guard.js";
import { ConsoleHttpError, consoleErrorBody } from "./http-errors.js";
import type { StaticAssetProvider } from "./static-assets.js";

export const MAX_CONSOLE_BODY_BYTES = 16 * 1024;
export const MAX_CONSOLE_URL_BYTES = 2_048;
export const MAX_CONSOLE_HEADERS = 32;
export const MAX_CONSOLE_CONNECTIONS = 32;
export const MAX_CONSOLE_REQUESTS_PER_SOCKET = 16;

export interface ConsoleServerInfo {
  readonly instanceId: string;
  readonly origin: string;
  readonly accessUrl: string;
  readonly port: number;
}

export interface ConsoleServerOptions {
  readonly assets: StaticAssetProvider;
  readonly auth?: ConsoleAuthGuard;
}

/** 严格白名单的本机 HTTP Origin；不提供 MCP transport 或通用工具调用接口。 */
export class ConsoleServer {
  private readonly auth: ConsoleAuthGuard;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private started = false;
  private closePromise: Promise<void> | undefined;

  public constructor(private readonly options: ConsoleServerOptions) {
    if (options.assets.read("/") === undefined) throw new Error("控制台静态入口缺失");
    this.auth = options.auth ?? new ConsoleAuthGuard();
    this.server = createServer({ maxHeaderSize: 8 * 1024, requireHostHeader: true },
      (request, response) => { void this.handle(request, response); });
    this.server.maxConnections = MAX_CONSOLE_CONNECTIONS;
    this.server.maxHeadersCount = MAX_CONSOLE_HEADERS;
    this.server.maxRequestsPerSocket = MAX_CONSOLE_REQUESTS_PER_SOCKET;
    this.server.keepAliveTimeout = 5_000;
    this.server.headersTimeout = 5_000;
    this.server.requestTimeout = 5_000;
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
  }

  public async start(): Promise<ConsoleServerInfo> {
    if (this.started || this.closePromise !== undefined) throw new Error("控制台已经启动或关闭");
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => { this.server.off("listening", onListening); reject(error); };
      const onListening = (): void => { this.server.off("error", onError); resolve(); };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(0, "127.0.0.1");
    });
    const address = this.server.address();
    if (address === null || typeof address === "string" || address.address !== "127.0.0.1") {
      await this.close();
      throw new Error("控制台未绑定到 IPv4 回环地址");
    }
    this.auth.activate(address.port);
    this.started = true;
    return Object.freeze({
      instanceId: this.auth.instanceId,
      origin: this.auth.origin(),
      accessUrl: this.auth.accessUrl(),
      port: address.port
    });
  }

  public close(): Promise<void> {
    this.closePromise ??= new Promise((resolve) => {
      this.auth.close();
      if (!this.server.listening) { resolve(); return; }
      this.server.close(() => resolve());
      this.server.closeIdleConnections();
      for (const socket of this.sockets) socket.destroy();
    });
    return this.closePromise;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if ((request.url?.length ?? 0) === 0 || request.url!.length > MAX_CONSOLE_URL_BYTES
        || request.rawHeaders.length / 2 > MAX_CONSOLE_HEADERS) {
        throw new ConsoleHttpError(400, "INVALID_REQUEST");
      }
      const path = request.url!;
      if (path.includes("?") || path.includes("%") || path.includes("\\") || path.includes("//")) {
        throw new ConsoleHttpError(404, "NOT_FOUND");
      }
      if ((request.method === "GET" || request.method === "HEAD")
        && (path === "/" || path.startsWith("/assets/"))) {
        this.auth.validateBase(request, false);
        const asset = this.options.assets.read(path);
        if (asset === undefined) throw new ConsoleHttpError(404, "NOT_FOUND");
        this.respond(response, 200, request.method === "HEAD" ? undefined : asset.body, contentType(path));
        return;
      }
      if (request.method === "POST" && path === "/api/v1/session") {
        this.auth.validateWrite(request);
        const body = await readJsonBody(request);
        if (!isAccessTokenBody(body)) throw new ConsoleHttpError(401, "UNAUTHORIZED");
        const cookie = this.auth.exchange(body.accessToken);
        this.respond(response, 204, undefined, undefined, { "set-cookie": cookie });
        return;
      }
      if (path.startsWith("/api/v1/")) {
        this.auth.validateBase(request, true);
        this.auth.validateSession(request);
      }
      throw new ConsoleHttpError(request.method === "OPTIONS" ? 405 : 404,
        request.method === "OPTIONS" ? "METHOD_NOT_ALLOWED" : "NOT_FOUND");
    } catch (error: unknown) {
      const safe = error instanceof ConsoleHttpError ? error : new ConsoleHttpError(400, "INVALID_REQUEST");
      if (!response.headersSent) {
        const body = Buffer.from(JSON.stringify(consoleErrorBody(safe.code)), "utf8");
        this.respond(response, safe.status, body, "application/json; charset=utf-8");
      } else {
        response.destroy();
      }
    }
  }

  private respond(
    response: ServerResponse,
    status: number,
    body?: Buffer,
    type?: string,
    extra: Readonly<Record<string, string>> = {}
  ): void {
    response.writeHead(status, {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      ...(type === undefined ? {} : { "content-type": type }),
      ...(body === undefined ? {} : { "content-length": String(body.length) }),
      ...extra
    });
    response.end(body);
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const declaredLength = request.headers["content-length"];
  if (Array.isArray(declaredLength) || (declaredLength !== undefined
    && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_CONSOLE_BODY_BYTES))) {
    throw new ConsoleHttpError(413, "PAYLOAD_TOO_LARGE");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_CONSOLE_BODY_BYTES) throw new ConsoleHttpError(413, "PAYLOAD_TOO_LARGE");
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ConsoleHttpError(400, "INVALID_REQUEST"); }
}

function isAccessTokenBody(value: unknown): value is { readonly accessToken: string } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 1 && typeof (value as Record<string, unknown>).accessToken === "string";
}

function contentType(path: string): string {
  if (path === "/") return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}
