import { describe, expect, it } from "vitest";
import type { HostConfig, SshMcpConfig } from "../../src/config/schema.js";
import { ProfileCompiler } from "../../src/policy/profile-compiler.js";
import { PolicyEngine } from "../../src/policy/policy-engine.js";

const linux: HostConfig = {
  alias: "linux-dev", environment: "test", platform: "linux", host: "127.0.0.1", port: 22,
  username: "tester", auth: { type: "pageant" }, shell: { type: "posix", command: "/bin/sh" },
  remoteRoots: ["/srv/project"]
};

const windows: HostConfig = {
  ...linux, alias: "windows-dev", platform: "windows", shell: { type: "powershell", command: "powershell.exe" },
  remoteRoots: ["C:\\Work"]
};

const profile = {
  id: "disk-usage",
  hostAliases: ["linux-dev"],
  platform: "linux" as const,
  executable: "/usr/bin/du",
  fixedArgs: ["-s"],
  parameters: [
    { type: "remotePath" as const, name: "path", required: true },
    { type: "integer" as const, name: "depth", required: false, minimum: 0, maximum: 4 },
    { type: "boolean" as const, name: "human", required: false },
    { type: "enum" as const, name: "unit", required: false, values: ["k", "m"] }
  ]
};

function engine(profiles: ReadonlyArray<SshMcpConfig["lowRiskProfiles"][number]> = [profile]): PolicyEngine {
  return new PolicyEngine(profiles);
}

describe("低风险 Profile 策略", () => {
  it("完整匹配只产生冻结结果，并将 Linux 每个值作为独立 POSIX 字面量", () => {
    const decision = engine().evaluate({
      profileId: "disk-usage", host: linux,
      parameters: { path: "/srv/project/a b'$(x)|>", depth: 2, human: false, unit: "m" }
    });
    expect(decision.matched).toBe(true);
    if (!decision.matched) return;
    expect(Object.isFrozen(decision.match)).toBe(true);
    expect(new ProfileCompiler().compile(decision.match)).toBe(
      "'/usr/bin/du' '-s' '/srv/project/a b'\"'\"'$(x)|>' '2' 'false' 'm'"
    );
  });

  it("Windows Cmdlet 使用未引号参数 token，false switch 明确绑定为 false", () => {
    const profileWindows = { ...profile, id: "windows-probe", hostAliases: ["windows-dev"], platform: "windows" as const,
      commandType: "cmdlet" as const,
      executable: "Get-Item", fixedArgs: ["-Force", "-Filter", "*.txt"], parameters: [
        { type: "remotePath" as const, name: "LiteralPath", required: true },
        { type: "boolean" as const, name: "Verbose", required: false }
      ] };
    const decision = engine([profileWindows]).evaluate({
      profileId: "windows-probe", host: windows, parameters: { LiteralPath: "C:\\Work\\a ' b", Verbose: false }
    });
    expect(decision.matched).toBe(true);
    if (!decision.matched) return;
    expect(new ProfileCompiler().compile(decision.match)).toBe("& 'Get-Item' -Force -Filter '*.txt' -LiteralPath 'C:\\Work\\a '' b' -Verbose:$false");
  });

  it("Windows 原生命令把固定参数及动态名和值都作为独立字面量实参", () => {
    const profileWindows = { ...profile, id: "windows-native", hostAliases: ["windows-dev"], platform: "windows" as const,
      commandType: "native" as const,
      executable: "C:\\Program Files\\probe.exe", fixedArgs: ["--mode", "safe value", "-x"], parameters: [
        { type: "enum" as const, name: "Name", required: true, values: ["a ' | ; $(x)"] },
        { type: "boolean" as const, name: "Enabled", required: true }
      ] };
    const decision = engine([profileWindows]).evaluate({
      profileId: "windows-native", host: windows, parameters: { Name: "a ' | ; $(x)", Enabled: false }
    });
    expect(decision.matched).toBe(true);
    if (!decision.matched) return;
    expect(new ProfileCompiler().compile(decision.match)).toBe(
      "& 'C:\\Program Files\\probe.exe' '--mode' 'safe value' '-x' '-Name' 'a '' | ; $(x)' '-Enabled' 'false'"
    );
  });

  it("Windows remotePath 也按盘符、大小写和根段边界进行纯词法拒绝", () => {
    const profileWindows = { ...profile, id: "windows-path", hostAliases: ["windows-dev"], platform: "windows" as const,
      commandType: "native" as const,
      parameters: [{ type: "remotePath" as const, name: "path", required: true }] };
    const decision = engine([profileWindows]).evaluate({
      profileId: "windows-path", host: windows, parameters: { path: "C:\\Workspace\\outside" }
    });
    expect(decision).toMatchObject({ matched: false, error: { code: "POLICY_REQUIRES_APPROVAL", sideEffects: "none" } });
  });

  it.each([
    ["未找到策略", "missing", linux, { path: "/srv/project/a" }, "POLICY_NOT_FOUND"],
    ["未授权主机", "disk-usage", windows, { path: "C:\\Work\\a" }, "POLICY_REQUIRES_APPROVAL"],
    ["缺少必填参数", "disk-usage", linux, {}, "POLICY_REQUIRES_APPROVAL"],
    ["未知参数", "disk-usage", linux, { path: "/srv/project/a", extra: true }, "POLICY_REQUIRES_APPROVAL"],
    ["类型错误", "disk-usage", linux, { path: "/srv/project/a", depth: "2" }, "POLICY_REQUIRES_APPROVAL"],
    ["超出整数范围", "disk-usage", linux, { path: "/srv/project/a", depth: 9 }, "POLICY_REQUIRES_APPROVAL"],
    ["枚举部分匹配", "disk-usage", linux, { path: "/srv/project/a", unit: "mm" }, "POLICY_REQUIRES_APPROVAL"],
    ["路径越过根", "disk-usage", linux, { path: "/srv/project/../private" }, "POLICY_REQUIRES_APPROVAL"],
    ["路径含换行", "disk-usage", linux, { path: "/srv/project/a\nwhoami" }, "POLICY_REQUIRES_APPROVAL"]
  ])("%s 时整体拒绝自动路径", (_label, profileId, host, parameters, code) => {
    const decision = engine().evaluate({ profileId, host: host as HostConfig, parameters });
    expect(decision).toMatchObject({ matched: false, error: { code, sideEffects: "none", retriable: false } });
  });

  it("平台或 Shell 声明不确定时整体拒绝，不能猜测或切换语言", () => {
    const platformMismatch = { ...windows, alias: "linux-dev" };
    const shellMismatch = { ...linux, shell: { type: "powershell", command: "powershell.exe" } } as unknown as HostConfig;
    expect(engine().evaluate({ profileId: "disk-usage", host: platformMismatch, parameters: { path: "C:\\Work\\a" } }))
      .toMatchObject({ matched: false, error: { code: "POLICY_REQUIRES_APPROVAL" } });
    expect(engine().evaluate({ profileId: "disk-usage", host: shellMismatch, parameters: { path: "/srv/project/a" } }))
      .toMatchObject({ matched: false, error: { code: "POLICY_REQUIRES_APPROVAL" } });
  });

  it("编译器拒绝未由策略引擎签发的对象", () => {
    expect(() => new ProfileCompiler().compile({ profile, host: linux, values: [] } as never)).toThrow(/未经验证/);
  });

  it("匹配快照不二次读取调用方可变 parameters，对象随后篡改不会改变编译命令", () => {
    const parameters: Record<string, unknown> = { path: "/srv/project/original", depth: 1 };
    const decision = engine().evaluate({ profileId: "disk-usage", host: linux, parameters });
    expect(decision.matched).toBe(true);
    parameters.path = "/srv/project/changed; whoami";
    parameters.depth = 4;
    if (!decision.matched) return;
    expect(new ProfileCompiler().compile(decision.match)).toContain("'/srv/project/original' '1'");
    expect(new ProfileCompiler().compile(decision.match)).not.toContain("changed");
  });
});
