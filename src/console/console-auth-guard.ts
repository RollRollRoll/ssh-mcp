import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { ConsoleHttpError } from "./http-errors.js";

export const CONSOLE_SESSION_COOKIE = "__Host-ssh_mcp_session";
export const CONSOLE_WRITE_HEADER = "x-ssh-mcp-request";

export interface ConsoleCredentials {
  readonly instanceId: string;
  readonly accessToken: string;
}

export interface ConsoleAuthGuardOptions {
  readonly credentialFactory?: () => ConsoleCredentials;
  readonly sessionTokenFactory?: () => string;
}

/** 单实例 capability 边界；只保存 token/session 的 SHA-256 摘要。 */
export class ConsoleAuthGuard {
  public readonly instanceId: string;
  private accessToken: string | undefined;
  private readonly accessDigest: Buffer;
  private readonly sessionTokenFactory: () => string;
  private readonly sessionDigests = new Set<Buffer>();
  private expectedHost: string | undefined;
  private expectedOrigin: string | undefined;
  private closed = false;

  public constructor(options: ConsoleAuthGuardOptions = {}) {
    const credentials = options.credentialFactory?.() ?? {
      instanceId: randomBytes(16).toString("hex"),
      accessToken: randomBytes(32).toString("base64url")
    };
    assertInstanceId(credentials.instanceId);
    assertToken(credentials.accessToken);
    this.instanceId = credentials.instanceId;
    this.accessToken = credentials.accessToken;
    this.accessDigest = digest(credentials.accessToken);
    this.sessionTokenFactory = options.sessionTokenFactory ?? (() => randomBytes(32).toString("base64url"));
  }

  public activate(port: number): void {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || this.expectedHost !== undefined) {
      throw new Error("控制台端口激活无效");
    }
    this.expectedHost = `${this.instanceId}.localhost:${port}`;
    this.expectedOrigin = `http://${this.expectedHost}`;
  }

  public accessUrl(): string {
    this.assertActive();
    if (this.accessToken === undefined) throw new Error("控制台访问 URL 已取出");
    const url = `${this.expectedOrigin}/#access_token=${this.accessToken}`;
    this.accessToken = undefined;
    return url;
  }

  public origin(): string {
    this.assertActive();
    return this.expectedOrigin!;
  }

  public host(): string {
    this.assertActive();
    return this.expectedHost!;
  }

  public validateBase(request: IncomingMessage, requireOrigin: boolean): void {
    this.assertActive();
    if (this.closed || !isLoopback(request.socket.remoteAddress)) throw new ConsoleHttpError(403, "FORBIDDEN");
    if (request.headers.host !== this.expectedHost) throw new ConsoleHttpError(403, "FORBIDDEN");
    if (Object.keys(request.headers).some((name) => name.startsWith("x-forwarded-") || name === "forwarded")) {
      throw new ConsoleHttpError(403, "FORBIDDEN");
    }
    if (requireOrigin && request.headers.origin !== this.expectedOrigin) throw new ConsoleHttpError(403, "FORBIDDEN");
    const fetchSite = request.headers["sec-fetch-site"];
    if (fetchSite !== undefined && fetchSite !== "same-origin"
      && (requireOrigin || fetchSite !== "none")) throw new ConsoleHttpError(403, "FORBIDDEN");
  }

  public validateWrite(request: IncomingMessage): void {
    this.validateBase(request, true);
    if (request.headers["content-type"] !== "application/json"
      || request.headers[CONSOLE_WRITE_HEADER] !== "1") {
      throw new ConsoleHttpError(403, "FORBIDDEN");
    }
  }

  /** 浏览器同源 GET 可能不发送 Origin；此时必须由严格 Fetch Metadata 证明同源。 */
  public validateRead(request: IncomingMessage): void {
    this.validateBase(request, false);
    if (request.headers.origin !== undefined && request.headers.origin !== this.expectedOrigin) {
      throw new ConsoleHttpError(403, "FORBIDDEN");
    }
    if (request.headers["sec-fetch-site"] !== "same-origin") {
      throw new ConsoleHttpError(403, "FORBIDDEN");
    }
  }

  public exchange(accessToken: unknown): string {
    if (this.closed || typeof accessToken !== "string" || !matchesDigest(accessToken, this.accessDigest)) {
      throw new ConsoleHttpError(401, "UNAUTHORIZED");
    }
    const sessionToken = this.sessionTokenFactory();
    assertToken(sessionToken);
    const sessionDigest = digest(sessionToken);
    if (this.sessionDigests.size >= 16) throw new ConsoleHttpError(429, "RESOURCE_LIMIT");
    this.sessionDigests.add(sessionDigest);
    return `${CONSOLE_SESSION_COOKIE}=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Strict`;
  }

  public validateSession(request: IncomingMessage): void {
    const token = readSingleCookie(request.headers.cookie, CONSOLE_SESSION_COOKIE);
    if (this.closed || token === undefined || !matchesAnyDigest(token, this.sessionDigests)) {
      throw new ConsoleHttpError(401, "UNAUTHORIZED");
    }
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.accessToken = undefined;
    this.accessDigest.fill(0);
    for (const sessionDigest of this.sessionDigests) sessionDigest.fill(0);
    this.sessionDigests.clear();
  }

  private assertActive(): void {
    if (this.expectedHost === undefined || this.expectedOrigin === undefined) throw new Error("控制台尚未激活");
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function matchesDigest(value: string, expected: Buffer): boolean {
  const actual = digest(value);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function matchesAnyDigest(value: string, expectedDigests: ReadonlySet<Buffer>): boolean {
  const actual = digest(value);
  let matched = 0;
  for (const expected of expectedDigests) {
    matched |= actual.length === expected.length && timingSafeEqual(actual, expected) ? 1 : 0;
  }
  return matched === 1;
}

function assertInstanceId(value: string): void {
  if (!/^[a-z0-9]{16,64}$/.test(value)) throw new RangeError("控制台实例 ID 格式无效");
}

function assertToken(value: string): void {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(value)) throw new RangeError("控制台 token 必须至少包含 256 bit 随机量");
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::ffff:127.0.0.1";
}

function readSingleCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined || header.length > 4_096) return undefined;
  const values = header.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (values.length !== 1) return undefined;
  const value = values[0]!.slice(name.length + 1);
  return value.length > 0 ? value : undefined;
}
