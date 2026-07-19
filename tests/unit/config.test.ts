import { describe, expect, it } from "vitest";
import { testWithIds } from "../test-with-ids.js";
import { ConfigLoader, loadConfigFromYaml } from "../../src/config/loader.js";

const baseConfig = `
version: 1
trustStore: /var/lib/ssh-mcp/trust.json
localRoots:
  - /workspace
hosts:
  - alias: linux-dev
    environment: development
    platform: linux
    host: 192.0.2.10
    port: 22
    username: developer
    auth:
      type: agent
      socket: /run/user/1000/agent.sock
    shell:
      type: posix
      command: /bin/sh
    remoteRoots:
      - /srv/project
`;

describe("严格 YAML 配置加载", () => {
  testWithIds(["SC-005"], "接受三种认证联合、1 台和 10 台唯一开发/测试主机，并默认空低风险规则", () => {
    const oneHost = loadConfigFromYaml(baseConfig);
    expect(oneHost.lowRiskProfiles).toEqual([]);
    expect(oneHost.hosts[0].auth).toMatchObject({ type: "agent" });

    const tenHosts = Array.from({ length: 10 }, (_, index) => `
  - alias: host-${index}
    environment: ${index % 2 === 0 ? "development" : "test"}
    platform: ${index % 2 === 0 ? "linux" : "windows"}
    host: 192.0.2.${index + 1}
    port: 22
    username: developer
    auth:
      type: ${index === 0 ? "agent" : index === 1 ? "pageant" : "privateKeyFile"}${index === 0 ? "\n      socket: /run/user/1000/agent.sock" : index === 1 ? "" : "\n      path: /keys/id_ed25519"}
    shell:
      type: ${index % 2 === 0 ? "posix" : "powershell"}
      command: ${index % 2 === 0 ? "/bin/sh" : "powershell.exe"}
    remoteRoots:
      - ${index % 2 === 0 ? "/srv/project" : "C:\\\\Work"}`).join("");

    expect(loadConfigFromYaml(baseConfig.replace(/hosts:[\s\S]*/, `hosts:${tenHosts}`)).hosts)
      .toHaveLength(10);
  });

  it.each([
    ["未知字段", baseConfig.replace("version: 1", "version: 1\nunexpected: true")],
    ["自定义标签", baseConfig.replace("version: 1", "version: !custom 1")],
    ["别名", baseConfig.replace("- /workspace", "- &root /workspace\n  - *root")],
    ["重复别名", baseConfig.replace("hosts:", "hosts:\n  - alias: linux-dev\n    environment: test\n    platform: linux\n    host: 192.0.2.11\n    port: 22\n    username: tester\n    auth:\n      type: pageant\n    shell:\n      type: posix\n      command: /bin/sh\n    remoteRoots:\n      - /srv/test")],
    ["零主机", baseConfig.replace(/  - alias:[\s\S]*/, "")],
    ["十一台主机", baseConfig.replace("hosts:", `hosts:${Array.from({ length: 10 }, (_, index) => `\n  - alias: extra-${index}\n    environment: test\n    platform: linux\n    host: 192.0.2.${index + 20}\n    port: 22\n    username: tester\n    auth:\n      type: pageant\n    shell:\n      type: posix\n      command: /bin/sh\n    remoteRoots:\n      - /srv/test`).join("")}`)],
    ["平台与 Shell 不匹配", baseConfig.replace("type: posix", "type: powershell")],
    ["相对敏感路径", baseConfig.replace("socket: /run/user/1000/agent.sock", "socket: relative.sock")],
    ["路径含词法上级目录", baseConfig.replace("- /srv/project", "- /srv/../project")],
    ["动态密码字段", baseConfig.replace("type: agent", "type: agent\n      password: secret")]
  ])("拒绝%s", (_name, source) => {
    expect(() => loadConfigFromYaml(source)).toThrow(/配置/);
  });

  testWithIds(["SC-007", "MN-003"], "拒绝生产环境主机进入可操作配置", () => {
    expect(() => loadConfigFromYaml(baseConfig.replace("environment: development", "environment: production")))
      .toThrow(/配置/);
  });

  it("拒绝 YAML 1.1 版本指令，避免 yes 被解析为布尔值", () => {
    const yaml11Config = `%YAML 1.1
---
${baseConfig.trim()}
lowRiskProfiles:
  - id: git-status
    hostAliases:
      - linux-dev
    platform: linux
    executable: /usr/bin/git
    parameters:
      - type: boolean
        name: porcelain
        required: yes
`;

    expect(() => loadConfigFromYaml(yaml11Config)).toThrow(/仅支持 YAML 1\.2/);
  });

  it.each([
    ["Agent socket 的 POSIX 上级目录", baseConfig.replace("socket: /run/user/1000/agent.sock", "socket: /run/user/../agent.sock")],
    ["Agent socket 的 Windows 上级目录", baseConfig.replace("socket: /run/user/1000/agent.sock", "socket: C:\\\\run\\\\..\\\\agent.sock")],
    ["私钥文件的 POSIX 上级目录", baseConfig.replace("type: agent\n      socket: /run/user/1000/agent.sock", "type: privateKeyFile\n      path: /keys/../id_ed25519")],
    ["私钥文件的 Windows 上级目录", baseConfig.replace("type: agent\n      socket: /run/user/1000/agent.sock", "type: privateKeyFile\n      path: C:/keys/../id_ed25519")],
    ["信任库的 POSIX 上级目录", baseConfig.replace("trustStore: /var/lib/ssh-mcp/trust.json", "trustStore: /var/lib/ssh-mcp/../trust.json")],
    ["信任库的 Windows 上级目录", baseConfig.replace("trustStore: /var/lib/ssh-mcp/trust.json", "trustStore: C:\\\\var\\\\lib\\\\..\\\\trust.json")]
  ])("拒绝%s", (_name, source) => {
    expect(() => loadConfigFromYaml(source)).toThrow(/配置/);
  });

  it("同一加载器只读取并解析一次", () => {
    let reads = 0;
    const loader = new ConfigLoader("/unused.yml", () => {
      reads += 1;
      return baseConfig;
    });

    expect(loader.load()).toBe(loader.load());
    expect(reads).toBe(1);
  });

  it("接受启动时冻结的结构化低风险 Profile 与整数范围", () => {
    const config = loadConfigFromYaml(`${baseConfig}
lowRiskProfiles:
  - id: disk-usage
    hostAliases: [linux-dev]
    platform: linux
    executable: /usr/bin/du
    fixedArgs: [-s]
    parameters:
      - type: remotePath
        name: path
        required: true
      - type: integer
        name: depth
        required: false
        minimum: 0
        maximum: 3
`);
    expect(config.lowRiskProfiles).toHaveLength(1);
    expect(Object.isFrozen(config.lowRiskProfiles[0])).toBe(true);
  });

  it("Windows Profile 必须显式声明 Cmdlet 或原生命令语义，Linux 不接受该字段", () => {
    const windowsConfig = baseConfig
      .replace("alias: linux-dev", "alias: windows-dev")
      .replace("platform: linux", "platform: windows")
      .replace("type: posix", "type: powershell")
      .replace("command: /bin/sh", "command: powershell.exe")
      .replace("- /srv/project", "- C:\\\\Work");
    const windowsProfile = `
  - id: inspect-temp
    hostAliases: [windows-dev]
    platform: windows
    commandType: cmdlet
    executable: Get-Item
    fixedArgs: [-Force]`;

    expect(loadConfigFromYaml(`${windowsConfig}\nlowRiskProfiles:${windowsProfile}\n`).lowRiskProfiles[0])
      .toMatchObject({ commandType: "cmdlet" });
    expect(() => loadConfigFromYaml(`${windowsConfig}\nlowRiskProfiles:${windowsProfile.replace("    commandType: cmdlet\n", "")}\n`)).toThrow(/配置/);
    expect(() => loadConfigFromYaml(`${baseConfig}\nlowRiskProfiles:${windowsProfile.replace("windows-dev", "linux-dev")}\n`)).toThrow(/配置/);
    expect(() => loadConfigFromYaml(`${baseConfig}\nlowRiskProfiles:\n  - id: invalid-linux-command-type\n    hostAliases: [linux-dev]\n    platform: linux\n    commandType: cmdlet\n    executable: /usr/bin/true\n`)).toThrow(/配置/);
  });

  it("启动时拒绝 Profile 与登记主机的平台或 Shell 组合不一致", () => {
    const windowsHost = `
  - alias: windows-dev
    environment: test
    platform: windows
    host: 192.0.2.20
    port: 22
    username: tester
    auth:
      type: pageant
    shell:
      type: powershell
      command: powershell.exe
    remoteRoots:
      - C:\\\\Work`;
    const windowsProfileOnLinux = `
  - id: invalid-windows-profile
    hostAliases: [linux-dev]
    platform: windows
    commandType: cmdlet
    executable: Get-Item`;
    const mixedAliases = `
  - id: invalid-mixed-profile
    hostAliases: [linux-dev, windows-dev]
    platform: linux
    executable: /usr/bin/true`;

    expect(() => loadConfigFromYaml(`${baseConfig}\nlowRiskProfiles:${windowsProfileOnLinux}\n`)).toThrow(/配置/);
    expect(() => loadConfigFromYaml(`${baseConfig}\n${windowsHost}\nlowRiskProfiles:${mixedAliases}\n`)).toThrow(/配置/);
  });

  it("拒绝无法无歧义表达的 Windows Cmdlet 固定参数", () => {
    const windowsConfig = baseConfig
      .replace("alias: linux-dev", "alias: windows-dev")
      .replace("platform: linux", "platform: windows")
      .replace("type: posix", "type: powershell")
      .replace("command: /bin/sh", "command: powershell.exe")
      .replace("- /srv/project", "- C:\\\\Work");
    expect(() => loadConfigFromYaml(`${windowsConfig}
lowRiskProfiles:
  - id: invalid-cmdlet-arguments
    hostAliases: [windows-dev]
    platform: windows
    commandType: cmdlet
    executable: Get-Item
    fixedArgs: ["-Force:$false"]
`)).toThrow(/配置/);
  });

  it.each([
    ["重复 Profile ID", `
  - id: duplicate
    hostAliases: [linux-dev]
    platform: linux
    executable: /usr/bin/true
  - id: duplicate
    hostAliases: [linux-dev]
    platform: linux
    executable: /usr/bin/true`],
    ["未登记 Profile 主机", `
  - id: missing-host
    hostAliases: [missing]
    platform: linux
    executable: /usr/bin/true`],
    ["重复 Profile 主机", `
  - id: duplicate-host
    hostAliases: [linux-dev, linux-dev]
    platform: linux
    executable: /usr/bin/true`],
    ["Profile 主机通配符", `
  - id: wildcard-host
    hostAliases: [linux-*]
    platform: linux
    executable: /usr/bin/true`],
    ["不安全参数名", `
  - id: unsafe-name
    hostAliases: [linux-dev]
    platform: linux
    executable: /usr/bin/true
    parameters: [{ type: boolean, name: x'; whoami, required: false }]`],
    ["重复参数名", `
  - id: duplicate-parameter
    hostAliases: [linux-dev]
    platform: linux
    executable: /usr/bin/true
    parameters:
      - { type: boolean, name: flag, required: false }
      - { type: integer, name: flag, required: false }`],
    ["整数范围反转", `
  - id: invalid-range
    hostAliases: [linux-dev]
    platform: linux
    executable: /usr/bin/true
    parameters: [{ type: integer, name: depth, required: false, minimum: 4, maximum: 1 }]`],
    ["可执行文件换行", `
  - id: unsafe-command
    hostAliases: [linux-dev]
    platform: linux
    executable: "/usr/bin/true\\nwhoami"`],
    ["固定参数控制字符", `
  - id: unsafe-argument
    hostAliases: [linux-dev]
    platform: linux
    executable: /usr/bin/true
    fixedArgs: ["--safe\\nwhoami"]`]
  ])("拒绝%s", (_name, profiles) => {
    expect(() => loadConfigFromYaml(`${baseConfig}\nlowRiskProfiles:${profiles}\n`)).toThrow(/配置/);
  });
});
