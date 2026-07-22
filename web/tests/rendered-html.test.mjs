import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("服务端渲染 SSH MCP 工作台", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html lang="zh-CN">/i);
  assert.match(html, /<title>SSH MCP · 安全运维工作台<\/title>/i);
  assert.match(html, /运维工作台/);
  assert.match(html, /每一次远程操作/);
  assert.match(html, /MCP 服务在线/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
});

test("页面包含审批交互与响应式样式", async () => {
  const [page, css, layout, packageJson] = await Promise.all([
    readFile(new URL("app/page.tsx", templateRoot), "utf8"),
    readFile(new URL("app/globals.css", templateRoot), "utf8"),
    readFile(new URL("app/layout.tsx", templateRoot), "utf8"),
    readFile(new URL("package.json", templateRoot), "utf8"),
  ]);

  assert.match(page, /确认远程操作/);
  assert.match(page, /批准并执行/);
  assert.match(page, /aria-modal="true"/);
  assert.match(page, /hosts\.map/);
  assert.match(css, /@media \(max-width: 620px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(layout, /lang="zh-CN"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});
