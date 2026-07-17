import { describe, expect, it } from "vitest";
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
  it("接受三种认证联合、1 台和 10 台唯一开发/测试主机，并默认空低风险规则", () => {
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
    ["非法环境", baseConfig.replace("environment: development", "environment: production")],
    ["平台与 Shell 不匹配", baseConfig.replace("type: posix", "type: powershell")],
    ["相对敏感路径", baseConfig.replace("socket: /run/user/1000/agent.sock", "socket: relative.sock")],
    ["路径含词法上级目录", baseConfig.replace("- /srv/project", "- /srv/../project")],
    ["动态密码字段", baseConfig.replace("type: agent", "type: agent\n      password: secret")]
  ])("拒绝%s", (_name, source) => {
    expect(() => loadConfigFromYaml(source)).toThrow(/配置/);
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
});
