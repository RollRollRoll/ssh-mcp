import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const specificationPath = fileURLToPath(new URL("../../docs/specs/2026-07-17-ssh-mcp-spec.md", import.meta.url));
const localConsoleSpecificationPath = fileURLToPath(new URL(
  "../../docs/specs/2026-07-22-ssh-mcp-local-console-spec.md", import.meta.url
));

interface CoverageEntry { readonly id: string; readonly file: string }

const scenarioCoverage: Readonly<Record<string, CoverageEntry>> = {
  "发现可用能力": { id: "SC-001", file: "contract/mcp-inspector.test.ts" },
  "拒绝额外或缺失参数": { id: "SC-002", file: "contract/mcp-inspector.test.ts" },
  "客户端不能呈现所需审批": { id: "SC-003", file: "contract/mcp-inspector.test.ts" },
  "列出登记主机": { id: "SC-004", file: "contract/hosts-list.test.ts" },
  "主机数量边界": { id: "SC-005", file: "unit/config.test.ts" },
  "拒绝未登记主机": { id: "SC-006", file: "contract/command-run.test.ts" },
  "拒绝生产环境登记": { id: "SC-007", file: "unit/config.test.ts" },
  "首次确认并建立信任": { id: "SC-008", file: "integration/linux/connection.test.ts" },
  "首次拒绝或无响应": { id: "SC-009", file: "unit/trust-store.test.ts" },
  "后续指纹一致": { id: "SC-010", file: "integration/linux/connection.test.ts" },
  "指纹发生变化": { id: "SC-011", file: "integration/linux/connection.test.ts" },
  "使用既有登录条件": { id: "SC-012", file: "integration/linux/connection.test.ts" },
  "认证失败": { id: "SC-013", file: "integration/linux/connection.test.ts" },
  "错误和诊断脱敏": { id: "SC-014", file: "unit/redaction.test.ts" },
  "自动执行明确允许的只读操作": { id: "SC-015", file: "contract/profile-run.test.ts" },
  "客户端尝试修改规则集": { id: "SC-016", file: "contract/profile-run.test.ts" },
  "未知或部分匹配的操作": { id: "SC-017", file: "contract/profile-run.test.ts" },
  "审批信息完整": { id: "SC-018", file: "unit/approval.test.ts" },
  "审批绑定精确操作": { id: "SC-019", file: "unit/approval.test.ts" },
  "拒绝或审批超时": { id: "SC-020", file: "unit/approval.test.ts" },
  "命令成功": { id: "SC-021", file: "integration/linux/command.test.ts" },
  "远程程序非零退出": { id: "SC-022", file: "integration/linux/command.test.ts" },
  "空命令": { id: "SC-023", file: "contract/command-run.test.ts" },
  "输出超过可返回范围": { id: "SC-024", file: "integration/linux/command.test.ts" },
  "不同平台不做命令翻译": { id: "SC-025", file: "contract/command-run.test.ts" },
  "创建交互会话": { id: "SC-026", file: "contract/session-tools.test.ts" },
  "保持 Shell 上下文": { id: "SC-027", file: "integration/linux/session.test.ts" },
  "完整终端交互": { id: "SC-028", file: "integration/linux/session.test.ts" },
  "输出游标与顺序": { id: "SC-029", file: "unit/session-manager.test.ts" },
  "会话隔离": { id: "SC-030", file: "integration/linux/session.test.ts" },
  "关闭会话的幂等性": { id: "SC-031", file: "unit/session-manager.test.ts" },
  "对失效会话操作": { id: "SC-032", file: "unit/session-manager.test.ts" },
  "查询长任务状态": { id: "SC-033", file: "contract/mcp-inspector.test.ts" },
  "操作超时": { id: "SC-034", file: "unit/operation-manager.test.ts" },
  "取消并确认停止": { id: "SC-035", file: "unit/command-runner.test.ts" },
  "无法确认取消结果": { id: "SC-036", file: "unit/command-runner.test.ts" },
  "不自动重试": { id: "SC-037", file: "contract/profile-run.test.ts" },
  "上传或下载单个文件": { id: "SC-038", file: "integration/linux/file-transfer.test.ts" },
  "递归传输目录": { id: "SC-039", file: "integration/linux/directory-transfer.test.ts" },
  "拒绝越界路径": { id: "SC-040", file: "unit/path-guards.test.ts" },
  "目标已存在": { id: "SC-041", file: "integration/linux/file-transfer.test.ts" },
  "明确批准覆盖": { id: "SC-042", file: "integration/linux/file-transfer.test.ts" },
  "遇到符号链接或重解析点": { id: "SC-043", file: "integration/linux/directory-transfer.test.ts" },
  "目录传输部分失败": { id: "SC-044", file: "integration/linux/directory-transfer.test.ts" },
  "传输进度": { id: "SC-045", file: "integration/linux/file-transfer.test.ts" },
  "并行执行多主机命令": { id: "SC-046", file: "unit/multi-host.test.ts" },
  "多主机顺序执行": { id: "SC-047", file: "unit/multi-host.test.ts" },
  "目标集合无效": { id: "SC-048", file: "unit/multi-host.test.ts" },
  "部分主机失败": { id: "SC-049", file: "unit/multi-host.test.ts" },
  "取消多主机操作": { id: "SC-050", file: "unit/multi-host.test.ts" },
  "Linux 主机": { id: "SC-051", file: "integration/linux/command.test.ts" },
  "Windows 主机": { id: "SC-052", file: "integration/windows/command.test.ts" },
  "平台声明与实际环境不兼容": { id: "SC-053", file: "unit/ssh-adapter.test.ts" },
  "文本与二进制编码": { id: "SC-054", file: "integration/linux/command.test.ts" },
  "连接类错误": { id: "SC-055", file: "integration/linux/connection.test.ts" },
  "操作类错误": { id: "SC-056", file: "unit/command-runner.test.ts" },
  "状态不可确定": { id: "SC-057", file: "unit/command-runner.test.ts" }
};

const mustNotCoverage: readonly CoverageEntry[] = [
  { id: "MN-001", file: "contract/mcp-inspector.test.ts" },
  { id: "MN-002", file: "contract/profile-run.test.ts" },
  { id: "MN-003", file: "unit/config.test.ts" },
  { id: "MN-004", file: "contract/mcp-inspector.test.ts" },
  { id: "MN-005", file: "contract/mcp-inspector.test.ts" },
  { id: "MN-006", file: "contract/command-run.test.ts" },
  { id: "MN-007", file: "acceptance/must-not.test.ts" },
  { id: "MN-008", file: "acceptance/must-not.test.ts" },
  { id: "MN-009", file: "integration/linux/directory-transfer.test.ts" },
  { id: "MN-010", file: "unit/multi-host.test.ts" },
  { id: "MN-011", file: "integration/linux/connection.test.ts" },
  { id: "MN-012", file: "unit/session-manager.test.ts" },
  { id: "MN-013", file: "contract/command-run.test.ts" }
];

const localConsoleScenarioCoverage: Readonly<Record<string, CoverageEntry>> = {
  "成功启动实例控制台": { id: "LC-SC-001", file: "contract/console-lifecycle.test.ts" },
  "多个实例同时运行": { id: "LC-SC-002", file: "contract/console-lifecycle.test.ts" },
  "控制台启动失败": { id: "LC-SC-003", file: "contract/server-bootstrap.test.ts" },
  "实例正常退出": { id: "LC-SC-004", file: "contract/console-lifecycle.test.ts" },
  "实例异常终止": { id: "LC-SC-005", file: "contract/server-bootstrap.test.ts" },
  "持有有效凭证的本机访问": { id: "LC-SC-006", file: "contract/console-server.test.ts" },
  "缺少、错误或属于其他实例的凭证": { id: "LC-SC-007", file: "contract/console-server.test.ts" },
  "非回环地址访问": { id: "LC-SC-008", file: "contract/console-server.test.ts" },
  "不可信网页尝试调用本机控制台": { id: "LC-SC-009", file: "contract/console-server.test.ts" },
  "凭证随实例失效": { id: "LC-SC-010", file: "contract/console-lifecycle.test.ts" },
  "实例处于活动状态": { id: "LC-SC-011", file: "contract/console-read.test.ts" },
  "展示登记主机": { id: "LC-SC-012", file: "contract/console-read.test.ts" },
  "没有活动状态": { id: "LC-SC-013", file: "web/tests/app.test.tsx" },
  "只读展示既有会话和传输": { id: "LC-SC-014", file: "web/tests/app.test.tsx" },
  "展示操作列表": { id: "LC-SC-015", file: "contract/console-read.test.ts" },
  "查看运行中命令输出": { id: "LC-SC-016", file: "contract/console-read.test.ts" },
  "输出被截断或已经过期": { id: "LC-SC-017", file: "contract/console-read.test.ts" },
  "状态不可确定": { id: "LC-SC-018", file: "unit/operation-manager.test.ts" },
  "预览并确认单次命令": { id: "LC-SC-019", file: "web/tests/console-actions.test.tsx" },
  "预览并确认 Profile": { id: "LC-SC-020", file: "web/tests/console-actions.test.tsx" },
  "预览后修改操作": { id: "LC-SC-021", file: "web/tests/console-actions.test.tsx" },
  "取消网页确认": { id: "LC-SC-022", file: "contract/console-actions.test.ts" },
  "拒绝无效网页输入": { id: "LC-SC-023", file: "contract/console-actions.test.ts" },
  "保持命令内容与平台语义": { id: "LC-SC-024", file: "contract/console-actions.test.ts" },
  "网页来源操作不打扰 MCP 客户端": { id: "LC-SC-025", file: "contract/console-actions.test.ts" },
  "两端展示同一审批": { id: "LC-SC-026", file: "contract/console-control.test.ts" },
  "网页先批准": { id: "LC-SC-027", file: "unit/approval.test.ts" },
  "MCP 客户端先批准": { id: "LC-SC-028", file: "unit/approval.test.ts" },
  "拒绝、取消与接受发生竞争": { id: "LC-SC-029", file: "contract/console-control.test.ts" },
  "网页拒绝或取消 MCP 来源审批": { id: "LC-SC-030", file: "contract/console-control.test.ts" },
  "MCP 客户端不支持审批但网页可用": { id: "LC-SC-031", file: "unit/approval.test.ts" },
  "所有审批通道均无有效决定": { id: "LC-SC-032", file: "unit/approval.test.ts" },
  "审批内容在等待期间发生变化": { id: "LC-SC-033", file: "contract/console-control.test.ts" },
  "请求取消运行中操作": { id: "LC-SC-034", file: "web/tests/console-control.test.tsx" },
  "确认操作已经停止": { id: "LC-SC-035", file: "unit/operation-manager.test.ts" },
  "取消与正常完成竞争": { id: "LC-SC-036", file: "web/tests/console-control.test.tsx" },
  "无法确认停止": { id: "LC-SC-037", file: "unit/operation-manager.test.ts" },
  "重复取消": { id: "LC-SC-038", file: "contract/console-control.test.ts" },
  "取消不允许取消的对象": { id: "LC-SC-039", file: "contract/console-control.test.ts" },
  "状态自动更新": { id: "LC-SC-040", file: "web/tests/console-state.test.ts" },
  "刷新或重新打开页面": { id: "LC-SC-041", file: "web/tests/console-state.test.ts" },
  "实时连接暂时中断": { id: "LC-SC-042", file: "web/tests/console-control.test.tsx" },
  "重连时遗漏了事件": { id: "LC-SC-043", file: "web/tests/console-state.test.ts" },
  "主机与配置摘要脱敏": { id: "LC-SC-044", file: "contract/console-read.test.ts" },
  "命令输出与错误脱敏": { id: "LC-SC-045", file: "unit/redaction.test.ts" },
  "不执行输出中的页面代码": { id: "LC-SC-046", file: "web/tests/app.test.tsx" },
  "达到实例资源限制": { id: "LC-SC-047", file: "contract/console-actions.test.ts" },
  "审批对话框的键盘与焦点行为": { id: "LC-SC-048", file: "web/tests/console-control.test.tsx" },
  "状态不只依赖颜色": { id: "LC-SC-049", file: "web/tests/app.test.tsx" },
  "执行危险操作前可完整检查": { id: "LC-SC-050", file: "web/tests/console-control.test.tsx" }
};

const localConsoleMustNotCoverage: readonly CoverageEntry[] = Array.from({ length: 12 }, (_value, index) => ({
  id: `LC-MN-${String(index + 1).padStart(3, "0")}`,
  file: "acceptance/must-not.test.ts"
}));

const localConsoleAcceptanceCoverage: readonly CoverageEntry[] = [
  { id: "LC-AC-001", file: "contract/console-lifecycle.test.ts" },
  { id: "LC-AC-002", file: "contract/console-lifecycle.test.ts" },
  { id: "LC-AC-003", file: "contract/console-server.test.ts" },
  { id: "LC-AC-004", file: "web/tests/console-actions.test.tsx" },
  { id: "LC-AC-005", file: "contract/console-control.test.ts" },
  { id: "LC-AC-006", file: "web/tests/console-control.test.tsx" },
  { id: "LC-AC-007", file: "web/tests/console-state.test.ts" },
  { id: "LC-AC-008", file: "web/tests/app.test.tsx" },
  { id: "LC-AC-009", file: "contract/server-bootstrap.test.ts" },
  { id: "LC-AC-010", file: "web/tests/console-control.test.tsx" },
  { id: "LC-AC-011", file: "acceptance/must-not.test.ts" }
];

const testsRoot = fileURLToPath(new URL("..", import.meta.url));
const webTestsRoot = fileURLToPath(new URL("../../web/tests", import.meta.url));
const executableTests = [
  ...testSources(testsRoot),
  ...testSources(webTestsRoot).map((entry) => ({ ...entry, file: `web/tests/${entry.file}` }))
].filter((entry) => !entry.file.endsWith("spec-coverage.test.ts"));

describe("规格覆盖验收", () => {
  it("AC-SPEC-01：每个 Scenario 的全局唯一 ID 在指定真实可运行测试标题中恰好出现一次", () => {
    const scenarios = [...readFileSync(specificationPath, "utf8").matchAll(/^#### Scenario：(.+)$/gm)].map((match) => match[1]!);
    expect(scenarios).toHaveLength(57);
    expect(Object.keys(scenarioCoverage).sort()).toEqual([...scenarios].sort());
    const ids = Object.values(scenarioCoverage).map(({ id }) => id);
    expect(new Set(ids).size).toBe(57);
    for (const [scenario, entry] of Object.entries(scenarioCoverage)) assertExecutableId(entry, scenario);
  });

  it("AC-SPEC-02：批准前零副作用与 13 条 MUST NOT 均指向唯一真实行为断言", () => {
    assertExecutableId({ id: "SAFE-APPROVAL-001", file: "unit/approval.test.ts" }, "批准前零副作用");
    expect(mustNotCoverage).toHaveLength(13);
    expect(new Set(mustNotCoverage.map(({ id }) => id)).size).toBe(13);
    mustNotCoverage.forEach((entry) => assertExecutableId(entry, entry.id));
  });

  it("LC-COVERAGE-01：本机控制台 50 个 Scenario 均映射到唯一可执行测试 ID", () => {
    const scenarios = [...readFileSync(localConsoleSpecificationPath, "utf8")
      .matchAll(/^#### Scenario：(.+)$/gm)].map((match) => match[1]!);
    expect(scenarios).toHaveLength(50);
    expect(Object.keys(localConsoleScenarioCoverage).sort()).toEqual([...scenarios].sort());
    expect(new Set(Object.values(localConsoleScenarioCoverage).map(({ id }) => id)).size).toBe(50);
    for (const [scenario, entry] of Object.entries(localConsoleScenarioCoverage)) assertExecutableId(entry, scenario);
  });

  it("LC-COVERAGE-02：12 条 MUST NOT 与 11 条成功标准均映射到唯一可执行测试 ID", () => {
    expect(localConsoleMustNotCoverage).toHaveLength(12);
    expect(localConsoleAcceptanceCoverage).toHaveLength(11);
    for (const entry of [...localConsoleMustNotCoverage, ...localConsoleAcceptanceCoverage]) {
      assertExecutableId(entry, entry.id);
    }
  });

  it("覆盖解析只接受导入 testWithIds 的调用表达式字面量参数", () => {
    const deceptive = `
      import { testWithIds } from "../test-with-ids.js";
      // testWithIds(["SC-999"], "注释伪造", () => undefined);
      const ordinary = "MN-999";
      it("SAFE-APPROVAL-001 普通标题", () => expect(ordinary).toBeTruthy());
      function neverInvoked() {
        testWithIds(["SC-998"], "未执行函数中的伪注册", () => undefined);
      }
    `;
    expect(executableIds("deceptive.test.ts", deceptive)).toEqual([]);
    expect(executableIds("valid.test.ts", `
      import { testWithIds } from "../test-with-ids.js";
      testWithIds(["SC-999", "MN-999"], "真实注册", () => undefined);
    `)).toEqual(["SC-999", "MN-999"]);
  });

  it("覆盖解析把调用精确绑定到 testWithIds 和 Vitest describe 的真实导入", () => {
    expect(executableIds("local-helper.test.ts", `
      import { describe } from "vitest";
      import { testWithIds } from "../test-with-ids.js";
      describe("真实作用域", () => {
        const testWithIds = (_ids: string[], _title: string, _body: () => void) => undefined;
        testWithIds(["SC-997"], "局部同名函数", () => undefined);
      });
    `)).toEqual([]);

    expect(executableIds("local-describe.test.ts", `
      import { describe } from "vitest";
      import { testWithIds } from "../test-with-ids.js";
      describe("真实外层", () => {
        const describe = (_title: string, callback: () => void) => callback();
        describe("局部同名作用域", () => {
          testWithIds(["SC-996"], "未注册 Vitest", () => undefined);
        });
      });
    `)).toEqual([]);

    expect(executableIds("aliased.test.ts", `
      import { describe as suite } from "vitest";
      import { testWithIds as register } from "../test-with-ids.js";
      suite("别名真实作用域", () => {
        register(["SC-995"], "别名真实注册", () => undefined);
      });
    `)).toEqual(["SC-995"]);

    expect(executableIds("nested-shadow.test.ts", `
      import { describe as suite } from "vitest";
      import { testWithIds as register } from "../test-with-ids.js";
      suite("真实作用域", () => {
        {
          const register = (_ids: string[], _title: string, _body: () => void) => undefined;
          register(["SC-994"], "嵌套遮蔽", () => undefined);
        }
      });
    `)).toEqual([]);

    expect(executableIds("wrong-module.test.ts", `
      import { describe } from "vitest";
      import { testWithIds } from "./evil/test-with-ids.js";
      describe("错误模块", () => {
        testWithIds(["SC-993"], "同名模块不能伪造", () => undefined);
      });
    `)).toEqual([]);
  });

  it("AC-DELIVERY-01：仓库提供独立平台入口、干净环境检查、双平台 CI 与保守使用文档", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    expect(packageJson.scripts.check).toContain("npm run build");
    expect(packageJson.scripts.check).toContain("npm run typecheck");
    expect(packageJson.scripts.check).toContain("vitest run");
    expect(packageJson.scripts["test:contract"]).toContain("tests/contract");
    expect(packageJson.scripts["test:acceptance"]).toContain("tests/acceptance");

    const workflowPath = `${root}/.github/workflows/ci.yml`;
    expect(existsSync(workflowPath)).toBe(true);
    const workflow = readFileSync(workflowPath, "utf8");
    expect(workflow).toContain("ubuntu-latest");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("npm ci");
    expect(workflow).toContain("test:integration:linux");
    expect(workflow).toContain("OpenSSH.Server");
    expect(workflow).toContain("test:integration:windows");

    const readmePath = `${root}/README.md`;
    const configurationPath = `${root}/docs/configuration.md`;
    expect(existsSync(readmePath)).toBe(true);
    expect(existsSync(configurationPath)).toBe(true);
    const readme = readFileSync(readmePath, "utf8");
    const configuration = readFileSync(configurationPath, "utf8");
    expect(readme).toContain("Node.js 24");
    expect(readme).toContain("stdio");
    expect(readme).toContain("form elicitation");
    expect(readme).toContain("非目标");
    expect(configuration).toContain("lowRiskProfiles");
    expect(configuration).toContain("TOFU");
    expect(configuration).toContain("私钥");
    expect(configuration).not.toMatch(/BEGIN (?:OPENSSH |RSA )?PRIVATE KEY/);
  });
});

function assertExecutableId(entry: CoverageEntry, label: string): void {
  expect(entry.id, label).toMatch(/^(?:SC-\d{3}|MN-\d{3}|LC-(?:SC|MN|AC)-\d{3}|SAFE-APPROVAL-001)$/);
  const occurrences = executableTests.flatMap(({ file, source }) =>
    executableIds(file, source).filter((id) => id === entry.id).map((id) => ({ file, id })));
  expect(occurrences, `${label} ${entry.id}`).toHaveLength(1);
  expect(occurrences[0]?.file, label).toBe(entry.file);
}

function executableIds(file: string, source: string): string[] {
  const { checker, sourceFile } = coverageProgram(file, source);

  const ids: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isTestWithIdsRegistration(node, checker) && runsDuringTestRegistration(node, checker)) {
      const metadata = node.arguments[0];
      if (!ts.isArrayLiteralExpression(metadata)) throw new Error(`${file}: testWithIds 首参数必须是字面量数组`);
      for (const element of metadata.elements) {
        if (!ts.isStringLiteral(element)) throw new Error(`${file}: testWithIds ID 必须是字符串字面量`);
        if (!/^(?:SC-\d{3}|MN-\d{3}|LC-(?:SC|MN|AC)-\d{3}|SAFE-APPROVAL-001)$/.test(element.text)) {
          throw new Error(`${file}: 非法测试 ID ${element.text}`);
        }
        ids.push(element.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return ids;
}

function coverageProgram(file: string, source: string): { checker: ts.TypeChecker; sourceFile: ts.SourceFile } {
  const virtualFile = `/${file.replaceAll("\\", "/")}`;
  const sourceFile = ts.createSourceFile(virtualFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest
  };
  const host = ts.createCompilerHost(options, true);
  host.fileExists = (candidate) => candidate === virtualFile;
  host.getSourceFile = (candidate) => candidate === virtualFile ? sourceFile : undefined;
  host.readFile = (candidate) => candidate === virtualFile ? source : undefined;
  const program = ts.createProgram([virtualFile], options, host);
  return { checker: program.getTypeChecker(), sourceFile: program.getSourceFile(virtualFile)! };
}

function isTestWithIdsRegistration(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
  const binding = testWithIdsBinding(call);
  return binding !== undefined && isNamedImport(binding, checker, "testWithIds", (moduleSpecifier, sourceFile) => {
    const imported = resolve(dirname(sourceFile.fileName), moduleSpecifier);
    return imported === "/test-with-ids.js" || imported === "/tests/test-with-ids.js";
  });
}

function testWithIdsBinding(call: ts.CallExpression): ts.Identifier | undefined {
  if (ts.isIdentifier(call.expression)) return call.expression;
  if (!ts.isCallExpression(call.expression) || !ts.isPropertyAccessExpression(call.expression.expression)) return undefined;
  const property = call.expression.expression;
  return ts.isIdentifier(property.expression) && property.name.text === "skipIf" ? property.expression : undefined;
}

function runsDuringTestRegistration(node: ts.Node, checker: ts.TypeChecker): boolean {
  for (let ancestor = node.parent; ancestor !== undefined; ancestor = ancestor.parent) {
    if (!ts.isFunctionLike(ancestor)) continue;
    const registration = ancestor.parent;
    if (!ts.isCallExpression(registration) || !registration.arguments.includes(ancestor as ts.Expression)
      || !isDescribeRegistration(registration, checker)) return false;
  }
  return true;
}

function isDescribeRegistration(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
  const binding = describeBinding(call);
  return binding !== undefined && isNamedImport(binding, checker, "describe", (moduleSpecifier) => moduleSpecifier === "vitest");
}

function describeBinding(call: ts.CallExpression): ts.Identifier | undefined {
  if (ts.isIdentifier(call.expression)) return call.expression;
  if (!ts.isCallExpression(call.expression) || !ts.isPropertyAccessExpression(call.expression.expression)) return undefined;
  const property = call.expression.expression;
  return ts.isIdentifier(property.expression) && ["skipIf", "runIf"].includes(property.name.text)
    ? property.expression
    : undefined;
}

function isNamedImport(
  identifier: ts.Identifier,
  checker: ts.TypeChecker,
  importedName: string,
  expectedModule: (moduleSpecifier: string, sourceFile: ts.SourceFile) => boolean
): boolean {
  const symbol = checker.getSymbolAtLocation(identifier);
  return symbol?.declarations?.some((declaration) => {
    if (!ts.isImportSpecifier(declaration) || (declaration.propertyName ?? declaration.name).text !== importedName) return false;
    const importDeclaration = declaration.parent.parent.parent;
    return ts.isImportDeclaration(importDeclaration)
      && ts.isStringLiteral(importDeclaration.moduleSpecifier)
      && expectedModule(importDeclaration.moduleSpecifier.text, identifier.getSourceFile());
  }) === true;
}

function testSources(root: string): Array<{ file: string; source: string }> {
  const entries: Array<{ file: string; source: string }> = [];
  const walk = (directory: string): void => {
    for (const dirent of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, dirent.name);
      if (dirent.isDirectory()) walk(absolute);
      else if (/\.test\.tsx?$/.test(dirent.name)) entries.push({
        file: relative(root, absolute).replaceAll("\\", "/"), source: readFileSync(absolute, "utf8")
      });
    }
  };
  walk(root);
  return entries;
}
