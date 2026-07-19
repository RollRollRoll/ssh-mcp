import { readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect } from "vitest";
import { resolveConfigPath } from "../../src/server.js";
import { testWithIds } from "../test-with-ids.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

describe("禁止能力的产品入口验收", () => {
  testWithIds(["MN-007"], "package 无业务 bin/HTTP/UI，唯一业务启动为 stdio 且参数只定位配置", () => {
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      readonly bin?: unknown;
      readonly main?: unknown;
      readonly exports?: unknown;
      readonly scripts: Readonly<Record<string, string>>;
    };
    expect(packageJson.bin).toBeUndefined();
    expect(packageJson.main).toBeUndefined();
    expect(packageJson.exports).toBeUndefined();
    expect(Object.keys(packageJson.scripts).sort()).toEqual([
      "build", "check", "pretest", "test", "test:acceptance", "test:contract",
      "test:integration:linux", "test:integration:windows", "typecheck"
    ]);

    const sources = sourceFiles(join(root, "src"));
    expect(sources.filter(({ source }) => source.includes("startServer()")))
      .toEqual([{ file: "index.ts", source: readFileSync(join(root, "src/index.ts"), "utf8") }]);
    const combined = sources.map(({ source }) => source).join("\n");
    expect(combined.match(/new StdioServerTransport\(/g)).toHaveLength(1);
    expect(combined).not.toMatch(/StreamableHTTP|SSEServerTransport|WebSocketServer|node:https?|createServer\s*\(.*(?:http|request|response)/i);

    const configured = join(root, "fixture.yml");
    expect(isAbsolute(configured)).toBe(true);
    expect(resolveConfigPath([], { SSH_MCP_CONFIG: configured })).toBe(configured);
    expect(resolveConfigPath(["--config", configured], {})).toBe(configured);
    expect(() => resolveConfigPath(["serve"], {})).toThrow(/仅支持 --config/);
    expect(() => resolveConfigPath(["--config", "relative.yml"], {})).toThrow(/绝对路径/);
  });

  testWithIds(["MN-008"], "工具/schema/SSH 连接配置均无转发、隧道、代理、X11 或 agent-forwarding 主动入口", () => {
    const schema = readFileSync(join(root, "src/config/schema.ts"), "utf8");
    const tools = readdirSync(join(root, "src/tools"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => readFileSync(join(root, "src/tools", name), "utf8"))
      .join("\n");
    const adapter = readFileSync(join(root, "src/ssh/ssh-adapter.ts"), "utf8");
    const forbiddenEntry = /forward(?:In|Out|Agent)?|tunnel|proxy(?:Command|Jump)?|x11|agentForward/i;
    expect(schema).not.toMatch(forbiddenEntry);
    expect(tools).not.toMatch(forbiddenEntry);
    expect(adapter).not.toMatch(forbiddenEntry);
    expect(adapter).not.toMatch(/\b(?:sock|forwardAgent|localAddress|localPort)\s*:/);
    expect(adapter).toContain("client.connect(config)");
  });
});

function sourceFiles(directory: string, base = directory): Array<{ readonly file: string; readonly source: string }> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute, base);
    if (!entry.name.endsWith(".ts")) return [];
    return [{ file: absolute.slice(base.length + 1).replaceAll("\\", "/"), source: readFileSync(absolute, "utf8") }];
  });
}
