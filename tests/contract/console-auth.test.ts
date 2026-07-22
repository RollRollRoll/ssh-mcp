import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import {
  CONSOLE_SESSION_COOKIE,
  ConsoleAuthGuard
} from "../../src/console/console-auth-guard.js";

describe("ConsoleAuthGuard", () => {
  it("生成实例私有 Origin，并以常量长度摘要交换严格 host-only Cookie", () => {
    const guard = auth("instancealpha1234", "a", "b");
    guard.activate(43210);
    expect(guard.origin()).toBe("http://instancealpha1234.localhost:43210");
    expect(guard.accessUrl()).toBe(`http://instancealpha1234.localhost:43210/#access_token=${"a".repeat(43)}`);
    const cookie = guard.exchange("a".repeat(43));
    expect(cookie).toBe(`${CONSOLE_SESSION_COOKIE}=${"b".repeat(43)}; Path=/; HttpOnly; Secure; SameSite=Strict`);
    expect(cookie).not.toContain("Domain=");
    expect(cookie).not.toContain("Expires=");
    expect(() => guard.exchange("wrong")).toThrow(expect.objectContaining({ status: 401, code: "UNAUTHORIZED" }));
  });

  it("同时校验回环 socket、精确 Host/Origin、Fetch Metadata 与唯一会话 Cookie", () => {
    const guard = auth("instancealpha1234", "a", "b");
    guard.activate(43210);
    guard.exchange("a".repeat(43));
    const valid = request({
      host: "instancealpha1234.localhost:43210",
      origin: "http://instancealpha1234.localhost:43210",
      "sec-fetch-site": "same-origin",
      cookie: `${CONSOLE_SESSION_COOKIE}=${"b".repeat(43)}`
    });
    expect(() => guard.validateBase(valid, true)).not.toThrow();
    expect(() => guard.validateSession(valid)).not.toThrow();

    expect(() => guard.validateBase(request({ ...valid.headers, host: "other.localhost:43210" }), true))
      .toThrow(expect.objectContaining({ status: 403 }));
    expect(() => guard.validateBase(request(valid.headers, "10.0.0.8"), true))
      .toThrow(expect.objectContaining({ status: 403 }));
    expect(() => guard.validateBase(request({ ...valid.headers, origin: "http://evil.example" }), true))
      .toThrow(expect.objectContaining({ status: 403 }));
    expect(() => guard.validateBase(request({ ...valid.headers, "sec-fetch-site": "cross-site" }), true))
      .toThrow(expect.objectContaining({ status: 403 }));
    expect(() => guard.validateBase(request({ ...valid.headers, "x-forwarded-host": valid.headers.host }), true))
      .toThrow(expect.objectContaining({ status: 403 }));
    expect(() => guard.validateSession(request({ ...valid.headers, cookie: `${CONSOLE_SESSION_COOKIE}=wrong` })))
      .toThrow(expect.objectContaining({ status: 401 }));
    expect(() => guard.validateSession(request({
      ...valid.headers,
      cookie: `${CONSOLE_SESSION_COOKIE}=${"b".repeat(43)}; ${CONSOLE_SESSION_COOKIE}=${"b".repeat(43)}`
    }))).toThrow(expect.objectContaining({ status: 401 }));
  });

  it("只读 GET 兼容浏览器省略 Origin，但仍要求严格同源 Fetch Metadata", () => {
    const guard = auth("instancealpha1234", "a", "b");
    guard.activate(43210);
    const browserRead = request({
      host: "instancealpha1234.localhost:43210",
      "sec-fetch-site": "same-origin"
    });
    expect(() => guard.validateRead(browserRead)).not.toThrow();
    expect(() => guard.validateRead(request({
      ...browserRead.headers, origin: "http://evil.example"
    }))).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => guard.validateRead(request({ host: browserRead.headers.host })))
      .toThrow(expect.objectContaining({ status: 403 }));
  });

  it("关闭后旧 access token 与会话立即失效", () => {
    const guard = auth("instancealpha1234", "a", "b");
    guard.activate(43210);
    guard.close();
    expect(() => guard.exchange("a".repeat(43))).toThrow(expect.objectContaining({ status: 401 }));
    expect(() => guard.validateSession(request({ cookie: `${CONSOLE_SESSION_COOKIE}=${"b".repeat(43)}` })))
      .toThrow(expect.objectContaining({ status: 401 }));
  });
});

function auth(instanceId: string, access: string, session: string): ConsoleAuthGuard {
  return new ConsoleAuthGuard({
    credentialFactory: () => ({ instanceId, accessToken: access.repeat(43) }),
    sessionTokenFactory: () => session.repeat(43)
  });
}

function request(headers: Record<string, string | string[] | undefined>, remoteAddress = "127.0.0.1"): IncomingMessage {
  return { headers, socket: { remoteAddress } } as never;
}
