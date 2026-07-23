import { readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect } from "vitest";
import { resolveConfigPath } from "../../src/server.js";
import { testWithIds } from "../test-with-ids.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

describe("禁止能力的产品入口验收", () => {
  testWithIds(["MN-007"], "package 仅提供 stdio 可执行入口，不提供 MCP HTTP transport", () => {
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      readonly bin?: Readonly<Record<string, string>>;
      readonly main?: unknown;
      readonly exports?: unknown;
      readonly private?: boolean;
      readonly scripts: Readonly<Record<string, string>>;
    };
    expect(packageJson.bin).toEqual({ "ssh-mcp": "dist/index.js" });
    expect(packageJson.main).toBeUndefined();
    expect(packageJson.exports).toBeUndefined();
    expect(packageJson.private).not.toBe(true);
    expect(Object.keys(packageJson.scripts).sort()).toEqual([
      "build", "check", "prepack", "pretest", "test", "test:acceptance", "test:contract",
      "test:integration:linux", "test:integration:windows", "typecheck"
    ]);
    expect(readFileSync(join(root, "src/index.ts"), "utf8")).toMatch(/^#!\/usr\/bin\/env node\n/);

    const sources = sourceFiles(join(root, "src"));
    expect(sources.filter(({ source }) => source.includes("startServer(resolution.path)")))
      .toEqual([{ file: "index.ts", source: readFileSync(join(root, "src/index.ts"), "utf8") }]);
    const combined = sources.map(({ source }) => source).join("\n");
    expect(combined.match(/new StdioServerTransport\(/g)).toHaveLength(1);
    expect(combined).not.toMatch(/StreamableHTTP|SSEServerTransport|WebSocketServer/i);
    const nonConsoleSources = sources.filter(({ file }) => !file.startsWith("console/"))
      .map(({ source }) => source).join("\n");
    expect(nonConsoleSources).not.toMatch(/node:https?/i);
    const consoleHttp = sources.find(({ file }) => file === "console/console-server.ts")?.source;
    expect(consoleHttp).toContain('from "node:http"');
    expect(consoleHttp).toContain('this.server.listen(0, "127.0.0.1")');

    const configured = join(root, "fixture.yml");
    expect(isAbsolute(configured)).toBe(true);
    expect(resolveConfigPath([], { SSH_MCP_CONFIG: configured })).toBe(configured);
    expect(resolveConfigPath(["--config", configured], {})).toBe(configured);
    expect(resolveConfigPath([], {}, root)).toBe(join(root, "ssh-mcp.yml"));
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

  testWithIds(["LC-MN-001", "LC-MN-002", "LC-MN-004", "LC-MN-008", "LC-MN-009", "LC-MN-012"],
    "控制台固定回环、逐实例鉴权、仅内存生命周期且不污染 stdio", () => {
      const consoleServer = readFileSync(join(root, "src/console/console-server.ts"), "utf8");
      const auth = readFileSync(join(root, "src/console/console-auth-guard.ts"), "utf8");
      const bootstrap = readFileSync(join(root, "src/server.ts"), "utf8");
      const entry = readFileSync(join(root, "src/index.ts"), "utf8");
      const consoleSources = sourceFiles(join(root, "src/console"))
        .filter(({ file }) => file !== "static-assets.ts").map(({ source }) => source).join("\n");
      expect(consoleServer).toContain('this.server.listen(0, "127.0.0.1")');
      expect(consoleServer).not.toMatch(/0\.0\.0\.0|::/);
      expect(auth).toContain("timingSafeEqual");
      expect(auth).toContain("instanceId");
      expect(consoleSources).not.toMatch(/node:fs|node:sqlite|indexedDB|localStorage|sessionStorage/i);
      expect(`${bootstrap}\n${entry}`).not.toMatch(/node:child_process/);
      const packageJson = readFileSync(join(root, "package.json"), "utf8");
      expect(packageJson).not.toMatch(/"(?:open|opn)"\s*:/i);
      expect(consoleSources).not.toMatch(/process\.stdout|console\.log/);
      expect(bootstrap).toContain("logger.consoleReady(consoleInfo.accessUrl)");
    });

  testWithIds(["LC-MN-003", "LC-MN-005", "LC-MN-006", "LC-MN-007", "LC-MN-010"],
    "网页无登录、终端、文件、多主机、持久化、外部通知或危险渲染入口", () => {
      const webSources = sourceFiles(join(root, "web/src")).map(({ source }) => source).join("\n");
      const actions = readFileSync(join(root, "src/console/action-routes.ts"), "utf8");
      expect(webSources).not.toMatch(/用户名|密码登录|角色管理|凭证签发/);
      expect(webSources).not.toMatch(/type=["']file|dragover|ondrop|session_write|session_resize|session_open/i);
      expect(webSources).not.toMatch(/file_upload|file_download|FormData|showOpenFilePicker/i);
      expect(webSources).not.toMatch(/localStorage|sessionStorage|indexedDB|dangerouslySetInnerHTML/i);
      expect(webSources).not.toMatch(/https?:\/\/|sendBeacon|Notification|WebSocket/i);
      expect(actions.match(/host: boundedText/g)).toHaveLength(2);
      expect(actions).not.toMatch(/hosts:\s*z\.array/);
    });

  testWithIds(["LC-MN-011"], "网页动作只调用共享应用服务，不直接连接 SSH 或复制执行规则", () => {
    const actions = readFileSync(join(root, "src/console/action-routes.ts"), "utf8");
    const server = readFileSync(join(root, "src/server.ts"), "utf8");
    expect(actions).toContain("CommandApplicationService");
    expect(actions).toContain("ProfileApplicationService");
    expect(actions).not.toMatch(/ssh2|SshAdapter|\.connect\(/);
    expect(server).toContain("new ConsoleActionRoutes(\n    commandApplication,\n    profileApplication");
  });

  testWithIds(["LC-AC-011"], "根检查统一覆盖后端、控制台构建、类型和行为测试", () => {
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      readonly scripts: Readonly<Record<string, string>>;
      readonly files: readonly string[];
      readonly workspaces: readonly string[];
    };
    expect(packageJson.files).toContain("dist");
    expect(packageJson.workspaces).toContain("./web");
    expect(packageJson.scripts.build).toContain("npm run build --workspace=web");
    expect(packageJson.scripts.check).toContain("npm run build");
    expect(packageJson.scripts.check).toContain("npm run typecheck");
    expect(packageJson.scripts.check).toContain("tests/unit tests/contract tests/acceptance");
    expect(packageJson.scripts.check).toContain("npm run test --workspace=web");
  });
});

function sourceFiles(directory: string, base = directory): Array<{ readonly file: string; readonly source: string }> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute, base);
    if (!/\.tsx?$/.test(entry.name)) return [];
    return [{ file: absolute.slice(base.length + 1).replaceAll("\\", "/"), source: readFileSync(absolute, "utf8") }];
  });
}
