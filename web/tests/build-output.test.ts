import { execFile as executeFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadStaticAssets } from "../../src/console/static-assets";

const execFile = promisify(executeFile);
const webRoot = process.cwd();
const consoleRoot = resolve(webRoot, "../dist/console");
const backendMarker = resolve(consoleRoot, "preserved-backend.js");

describe("控制台静态构建", () => {
  beforeAll(async () => {
    mkdirSync(consoleRoot, { recursive: true });
    writeFileSync(backendMarker, "export {};\n");
    await execFile(process.execPath, ["node_modules/vite/bin/vite.js", "build"], {
      cwd: webRoot,
      env: { ...process.env, NODE_ENV: "production" },
    });
  });
  afterAll(() => rmSync(backendMarker, { force: true }));

  it("前端重建只清理静态资源，不删除同目录的后端编译模块", () => {
    expect(readFileSync(backendMarker, "utf8")).toBe("export {};\n");
  });

  it("生成可由本机静态资源提供器读取的同源哈希资源", async () => {
    const assets = await loadStaticAssets(consoleRoot);
    const indexHtml = assets.read("/")?.body.toString("utf8");
    const assetPaths = assets.paths.filter((path) => path.startsWith("/assets/"));
    const cssPaths = assetPaths.filter((path) => path.endsWith(".css"));
    const cssContents = cssPaths.map((path) => assets.read(path)?.body.toString("utf8"));

    expect(indexHtml).toBeDefined();
    expect(indexHtml).toContain('<div id="root"></div>');
    expect(indexHtml).toMatch(/<script[^>]+\bsrc="\/assets\/[^"]+\.js"[^>]*><\/script>/);
    expect(indexHtml).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(indexHtml).not.toMatch(/https?:\/\//i);
    expect(assetPaths.some((path) => /\/assets\/.+\.js$/.test(path))).toBe(true);
    expect(assetPaths.some((path) => /\/assets\/.+\.css$/.test(path))).toBe(true);
    expect(assets.paths).toEqual(["/", ...assetPaths]);
    expect(assetPaths.every((path) => /\/assets\/.+-[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(path))).toBe(true);
    expect(cssContents.join("\n")).not.toMatch(/url\(\s*["']?https?:/i);
    expect(assets.read("/assets/../index.html")).toBeUndefined();
    expect(assets.read("/not-in-manifest")).toBeUndefined();
  });

  it("不在构建 JavaScript 中引入外部能力", async () => {
    const assets = await loadStaticAssets(consoleRoot);
    const scripts = assets.paths
      .filter((path) => path.endsWith(".js"))
      .map((path) => assets.read(path)?.body.toString("utf8"))
      .join("\n");

    expect(scripts).not.toMatch(/\b(?:fetch|import)\s*\(\s*["'`]https?:\/\//i);
    expect(scripts).not.toMatch(/\b(?:src|href)\s*=\s*["'`]https?:\/\//i);
    expect(scripts).not.toMatch(/\.setAttribute\(\s*["'`](?:src|href)["'`]\s*,\s*["'`]https?:\/\//i);
    expect(scripts).not.toMatch(/\bnavigator\.serviceWorker\.register\s*\(/i);
    expect(scripts).not.toMatch(/\b(?:google-analytics|googletagmanager|plausible|segment|mixpanel)\b/i);
    expect(scripts).not.toMatch(/\/(?:_next|_vercel)\/image\b/i);
    expect(scripts).not.toContain("Download the React DevTools for a better development experience");
  });
});
