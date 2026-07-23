import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultConfig, DEFAULT_CONFIG_FILENAME } from "../../src/config/default-config.js";
import { loadConfigFromYaml } from "../../src/config/loader.js";

describe("默认配置生成", () => {
  it("在目标目录生成可解析的安全模板，并且不覆盖已有文件", () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), "ssh-mcp-default-config-"));
    const configPath = join(workingDirectory, DEFAULT_CONFIG_FILENAME);

    expect(createDefaultConfig(configPath)).toBe(true);
    const generated = readFileSync(configPath, "utf8");
    expect(loadConfigFromYaml(generated)).toMatchObject({
      version: 1,
      localRoots: [workingDirectory],
      hosts: [{
        alias: "example-development",
        host: "192.0.2.10",
        username: "replace-me"
      }]
    });

    expect(createDefaultConfig(configPath)).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(generated);
  });
});
