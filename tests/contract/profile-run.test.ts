import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import type { HostConfig, LowRiskProfile } from "../../src/config/schema.js";
import { CommandRunner } from "../../src/commands/command-runner.js";
import { HostRegistry } from "../../src/hosts/host-registry.js";
import { OperationManager } from "../../src/operations/operation-manager.js";
import { PolicyEngine } from "../../src/policy/policy-engine.js";
import { createServer } from "../../src/server.js";

const host: HostConfig = {
  alias: "linux", environment: "test", platform: "linux", host: "127.0.0.1", port: 22,
  username: "tester", auth: { type: "pageant" }, shell: { type: "posix", command: "/bin/sh" }, remoteRoots: ["/srv/project"]
};
const profiles: readonly LowRiskProfile[] = [{
  id: "du", hostAliases: ["linux"], platform: "linux", executable: "/usr/bin/du", fixedArgs: ["-s"],
  parameters: [{ type: "remotePath", name: "path", required: true }]
}];

describe("profile_run MCP 契约", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); });

  it("默认空规则、未知或不完整匹配均不创建操作、不连接也不审批", async () => {
    let connections = 0;
    const empty = await connect([], () => { connections += 1; });
    await expect(empty.client.callTool({ name: "profile_run", arguments: { profileId: "du", hosts: ["linux"], parameters: { path: "/srv/project/a" } } }))
      .resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "POLICY_NOT_FOUND", sideEffects: "none" } } });

    const configured = await connect(profiles, () => { connections += 1; });
    await expect(configured.client.callTool({ name: "profile_run", arguments: { profileId: "du", hosts: ["linux"], parameters: { path: "/outside" } } }))
      .resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "POLICY_REQUIRES_APPROVAL", sideEffects: "none" } } });
    await expect(configured.client.callTool({ name: "profile_run", arguments: { profileId: "du", hosts: ["missing"], parameters: { path: "/srv/project/a" } } }))
      .resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "HOST_NOT_REGISTERED", sideEffects: "none" } } });
    await expect(configured.client.callTool({ name: "profile_run", arguments: { profileId: "missing", hosts: ["missing"], parameters: {} } }))
      .resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "POLICY_NOT_FOUND", sideEffects: "none" } } });
    expect(connections).toBe(0);
  });

  it("完整匹配只启动一次并立即返回 running，工具输入不接受命令或规则覆盖字段", async () => {
    let connections = 0;
    const { client } = await connect(profiles, () => { connections += 1; });
    await expect(client.callTool({ name: "profile_run", arguments: { profileId: "du", hosts: ["linux"], parameters: { path: "/srv/project/a b" } } }))
      .resolves.toMatchObject({ structuredContent: { operationId: "profile-1", state: "running" } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(connections).toBe(1);
    await expect(client.callTool({ name: "profile_run", arguments: { profileId: "du", hosts: ["linux"], parameters: { path: "/srv/project/a" }, command: "whoami" } }))
      .resolves.toMatchObject({ isError: true });
    await expect(client.callTool({ name: "profile_run", arguments: { profileId: "du", hosts: ["linux", "linux"], parameters: { path: "/srv/project/a" } } }))
      .resolves.toMatchObject({ isError: true });
    await expect(client.callTool({ name: "profile_run", arguments: { profileId: "du", hosts: ["linux"], parameters: { path: "/srv/project/a", unknown: true } } }))
      .resolves.toMatchObject({ isError: true, structuredContent: { error: { code: "POLICY_REQUIRES_APPROVAL" } } });

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("profile_run");
    expect(tools.tools.map((tool) => tool.name)).not.toEqual(expect.arrayContaining([
      "profile_create", "profile_update", "profile_delete", "profile_override", "profile_reload"
    ]));
  });

  async function connect(configuredProfiles: readonly LowRiskProfile[], onConnect: () => void): Promise<{ client: Client }> {
    const registry = new HostRegistry([host]);
    const manager = new OperationManager({ idFactory: () => "profile-1" });
    const runner = new CommandRunner({ connect: async () => {
      onConnect();
      return await new Promise<never>(() => undefined);
    } }, manager);
    const server = createServer(registry, manager, undefined, { registry, runner, policy: new PolicyEngine(configuredProfiles) });
    const client = new Client({ name: "contract-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closers.push(async () => { await client.close(); await server.close(); });
    return { client };
  }
});
