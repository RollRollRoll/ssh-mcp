import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ConsoleAuthGuard, CONSOLE_SESSION_COOKIE } from "../../src/console/console-auth-guard.js";
import { ConsoleServer, MAX_CONSOLE_BODY_BYTES } from "../../src/console/console-server.js";
import type { StaticAssetProvider } from "../../src/console/static-assets.js";

const assets: StaticAssetProvider = Object.freeze({
  paths: Object.freeze(["/", "/assets/app.js", "/assets/app.css"]),
  read(path: string) {
    const bodies: Record<string, string> = {
      "/": "<!doctype html><script type=\"module\" src=\"/assets/app.js\"></script>",
      "/assets/app.js": "document.body.dataset.ready = 'true'",
      "/assets/app.css": "body { color: black; }"
    };
    const body = bodies[path];
    return body === undefined ? undefined : { path, body: Buffer.from(body) };
  }
});

describe("ConsoleServer", () => {
  const servers: ConsoleServer[] = [];
  afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); });

  it("只监听 IPv4 回环随机端口，并只服务清单内静态资源与安全响应头", async () => {
    const { server, info } = await start("instancealpha1234", "a", "b");
    servers.push(server);
    expect(info.port).toBeGreaterThan(0);
    expect(info.origin).toBe(`http://instancealpha1234.localhost:${info.port}`);
    expect(info.accessUrl).toContain("/#access_token=");

    const page = await send(info.port, {
      path: "/", host: `instancealpha1234.localhost:${info.port}`,
      headers: { "sec-fetch-site": "none" }
    });
    expect(page.status).toBe(200);
    expect(page.body).toContain("/assets/app.js");
    expect(page.body).not.toContain("access_token");
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(page.headers["access-control-allow-origin"]).toBeUndefined();

    expect((await send(info.port, { path: "/assets/app.js", host: `instancealpha1234.localhost:${info.port}` })).status).toBe(200);
    expect((await send(info.port, { path: "/assets/missing.js", host: `instancealpha1234.localhost:${info.port}` })).status).toBe(404);
    for (const path of ["/../secret", "/assets/%2e%2e/secret", "/assets/../../secret", "/assets\\secret", "/?file=/etc/passwd"]) {
      expect((await send(info.port, { path, host: `instancealpha1234.localhost:${info.port}` })).status).toBe(404);
    }
    expect((await send(info.port, { path: "/", host: `evil.localhost:${info.port}` })).status).toBe(403);
  });

  it("token 只经严格同源 JSON 交换为 Cookie，受保护请求拒绝错误来源与跨实例凭证", async () => {
    const first = await start("instancealpha1234", "a", "b");
    const second = await start("instancebeta12345", "c", "d");
    servers.push(first.server, second.server);
    const firstHost = `instancealpha1234.localhost:${first.info.port}`;
    const firstOrigin = `http://${firstHost}`;
    const secondHost = `instancebeta12345.localhost:${second.info.port}`;
    const exchange = await send(first.info.port, {
      method: "POST", path: "/api/v1/session", host: firstHost,
      headers: writeHeaders(firstOrigin), body: JSON.stringify({ accessToken: "a".repeat(43) })
    });
    expect(exchange.status).toBe(204);
    const cookie = String(exchange.headers["set-cookie"]?.[0]).split(";")[0]!;
    expect(exchange.headers["set-cookie"]?.[0]).toContain("HttpOnly; Secure; SameSite=Strict");

    expect((await send(first.info.port, {
      path: "/api/v1/unknown", host: firstHost,
      headers: { origin: firstOrigin, "sec-fetch-site": "same-origin", cookie }
    })).status).toBe(404);
    expect((await send(first.info.port, {
      path: "/api/v1/unknown", host: firstHost,
      headers: { origin: firstOrigin, "sec-fetch-site": "same-origin", cookie: `${CONSOLE_SESSION_COOKIE}=wrong` }
    })).status).toBe(401);
    expect((await send(first.info.port, {
      path: "/api/v1/unknown", host: firstHost,
      headers: { origin: "http://evil.example", "sec-fetch-site": "cross-site", cookie }
    })).status).toBe(403);

    const crossedToken = await send(second.info.port, {
      method: "POST", path: "/api/v1/session", host: secondHost,
      headers: writeHeaders(`http://${secondHost}`), body: JSON.stringify({ accessToken: "a".repeat(43) })
    });
    expect(crossedToken.status).toBe(401);
    expect(crossedToken.body).not.toContain("token");
    expect((await send(second.info.port, {
      path: "/api/v1/unknown", host: secondHost,
      headers: { origin: `http://${secondHost}`, "sec-fetch-site": "same-origin", cookie }
    })).status).toBe(401);
  });

  it("拒绝非 JSON、缺少自定义头、预检、超长 URL 与过大 body，错误不回显输入", async () => {
    const { server, info } = await start("instancealpha1234", "a", "b");
    servers.push(server);
    const host = `instancealpha1234.localhost:${info.port}`;
    const origin = `http://${host}`;
    const secret = "不得回显的访问凭证";
    expect((await send(info.port, {
      method: "POST", path: "/api/v1/session", host,
      headers: { origin, "sec-fetch-site": "same-origin", "content-type": "text/plain" }, body: secret
    })).status).toBe(403);
    expect((await send(info.port, {
      method: "POST", path: "/api/v1/session", host,
      headers: { origin, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ accessToken: secret })
    })).status).toBe(403);
    expect((await send(info.port, { method: "OPTIONS", path: "/api/v1/session", host })).status).toBe(403);
    expect((await send(info.port, { path: `/${"x".repeat(2_100)}`, host })).status).toBe(400);
    const oversized = await send(info.port, {
      method: "POST", path: "/api/v1/session", host,
      headers: writeHeaders(origin), body: JSON.stringify({ accessToken: "x".repeat(MAX_CONSOLE_BODY_BYTES) })
    });
    expect(oversized.status).toBe(413);
    expect(oversized.body).not.toContain("xxxxx");
  });
});

async function start(instanceId: string, access: string, session: string) {
  const server = new ConsoleServer({
    assets,
    auth: new ConsoleAuthGuard({
      credentialFactory: () => ({ instanceId, accessToken: access.repeat(43) }),
      sessionTokenFactory: () => session.repeat(43)
    })
  });
  return { server, info: await server.start() };
}

function writeHeaders(origin: string): Record<string, string> {
  return {
    origin,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    "x-ssh-mcp-request": "1"
  };
}

async function send(port: number, input: {
  readonly method?: string;
  readonly path: string;
  readonly host: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}): Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1", port, method: input.method ?? "GET", path: input.path,
      headers: { host: input.host, ...input.headers }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.on("error", reject);
    request.end(input.body);
  });
}
