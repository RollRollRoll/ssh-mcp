import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { ErrorCodes } from "../../src/errors/error-codes.js";
import { JsonLogger } from "../../src/observability/logger.js";
import { startServer } from "../../src/server.js";

describe("config_reload", () => {
  it("成功替换主机快照，无效或进程级字段变更时保留当前配置", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ssh-mcp-config-reload-"));
    const configPath = join(directory, "ssh-mcp.yml");
    writeFileSync(configPath, config("example-development"));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const runtime = await startServer(configPath, {
      transport: serverTransport,
      adapter: { connect: async () => { throw new Error("未调用"); }, shutdown: () => undefined },
      logger: new JsonLogger({ write: () => undefined }),
      shutdownTimeoutMs: 20
    });
    const client = new Client({ name: "config-reload-test", version: "1" });
    await client.connect(clientTransport);

    try {
      await expect(client.callTool({ name: "config_reload", arguments: { path: "/other.yml" } }))
        .resolves.toMatchObject({ isError: true });

      writeFileSync(configPath, config("actual-development"));
      await expect(client.callTool({ name: "config_reload", arguments: {} })).resolves.toMatchObject({
        structuredContent: { reloaded: true, hostCount: 1, profileCount: 0 }
      });
      await expect(client.callTool({ name: "hosts_list", arguments: {} })).resolves.toMatchObject({
        structuredContent: { hosts: [expect.objectContaining({ alias: "actual-development" })] }
      });
      expect(runtime.registry.get("actual-development")?.host).toBe("192.0.2.20");

      writeFileSync(configPath, "version: [invalid");
      await expect(client.callTool({ name: "config_reload", arguments: {} })).resolves.toMatchObject({
        isError: true,
        structuredContent: { reloaded: false, error: { code: ErrorCodes.CONFIG_INVALID } }
      });
      expect(runtime.registry.list().map((host) => host.alias)).toEqual(["actual-development"]);

      writeFileSync(configPath, config("restart-only-change", "/other-workspace"));
      await expect(client.callTool({ name: "config_reload", arguments: {} })).resolves.toMatchObject({
        isError: true,
        structuredContent: { reloaded: false, error: { code: ErrorCodes.CONFIG_RESTART_REQUIRED } }
      });
      expect(runtime.registry.list().map((host) => host.alias)).toEqual(["actual-development"]);

      writeFileSync(configPath, config("retry-succeeds", "/workspace", true));
      await expect(client.callTool({ name: "config_reload", arguments: {} })).resolves.toMatchObject({
        structuredContent: { reloaded: true, hostCount: 1, profileCount: 1 }
      });
      expect(runtime.registry.list().map((host) => host.alias)).toEqual(["retry-succeeds"]);
    } finally {
      await client.close();
      await runtime.shutdown();
    }
  });
});

function config(alias: string, localRoot = "/workspace", withProfile = false): string {
  return `
version: 1
trustStore: /var/lib/ssh-mcp/trust.json
localRoots: [${localRoot}]
hosts:
  - alias: ${alias}
    environment: development
    platform: linux
    host: 192.0.2.20
    port: 22
    username: developer
    auth: { type: pageant }
    shell: { type: posix, command: /bin/sh }
    remoteRoots: [/srv/project]
${withProfile ? `lowRiskProfiles:
  - id: inspect-host
    hostAliases: [${alias}]
    platform: linux
    executable: /usr/bin/true
` : ""}
`;
}
