import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { testWithIds } from "../test-with-ids.js";
import { loadConfigFromYaml } from "../../src/config/loader.js";
import { HostRegistry } from "../../src/hosts/host-registry.js";
import { createServer } from "../../src/server.js";
import { ConnectionTrackingSshAdapter } from "../../src/ssh/connection-tracking-adapter.js";

const config = loadConfigFromYaml(`
version: 1
trustStore: /var/lib/ssh-mcp/trust.json
localRoots: [/workspace]
hosts:
  - alias: zeta
    environment: test
    platform: windows
    host: 192.0.2.20
    port: 22
    username: developer
    auth: { type: pageant }
    shell: { type: powershell, command: powershell.exe }
    remoteRoots: ['C:\\Work']
  - alias: alpha
    environment: development
    platform: linux
    host: 192.0.2.10
    port: 22
    username: developer
    auth: { type: agent, socket: /run/user/1000/agent.sock }
    shell: { type: posix, command: /bin/sh }
    remoteRoots: [/srv/project]
`);

describe("hosts_list", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  testWithIds(["SC-004"], "按别名字典序只返回公开状态，且不主动连接", async () => {
    const registry = new HostRegistry(config.hosts);
    const { client } = await connect(registry);

    const result = await client.callTool({ name: "hosts_list", arguments: {} });

    expect(result.structuredContent).toEqual({
      hosts: [
        { alias: "alpha", environment: "development", platform: "linux", shell: "posix", connectionState: "unknown" },
        { alias: "zeta", environment: "test", platform: "windows", shell: "powershell", connectionState: "unknown" }
      ]
    });
    expect(JSON.stringify(result)).not.toContain("agent.sock");
    expect(JSON.stringify(result)).not.toContain("pageant");
  });

  it("输入必须是严格空对象", async () => {
    const { client } = await connect(new HostRegistry(config.hosts));

    await expect(client.callTool({ name: "hosts_list", arguments: { host: "alpha" } }))
      .resolves.toMatchObject({ isError: true });
  });

  it("使用确定性的 UTF-16 字典序排序别名", () => {
    const registry = new HostRegistry([
      { ...config.hosts[0], alias: "ä" },
      { ...config.hosts[0], alias: "a" },
      { ...config.hosts[0], alias: "Z" },
      { ...config.hosts[0], alias: "z" }
    ]);

    expect(registry.list().map((host) => host.alias)).toEqual(["Z", "a", "z", "ä"]);
  });

  it("hosts_list 反映并发连接引用、最后关闭与失败连接的当前状态", async () => {
    const registry = new HostRegistry(config.hosts);
    let attempt = 0;
    const adapter = new ConnectionTrackingSshAdapter({
      connect: async (_host, timeoutMs) => {
        expect(timeoutMs).toBe(3210);
        attempt += 1;
        if (attempt === 3) throw new Error("连接失败");
        let closeListener: (() => void) | undefined;
        return {
          exec: () => undefined,
          openShell: () => undefined,
          close: () => closeListener?.(),
          onClose: (listener) => { closeListener = listener; }
        };
      }
    }, registry, 3210);
    const { client } = await connect(registry);
    const host = registry.get("alpha")!;
    const first = await adapter.connect(host);
    const second = await adapter.connect(host);
    await expect(client.callTool({ name: "hosts_list", arguments: {} })).resolves.toMatchObject({
      structuredContent: { hosts: [expect.objectContaining({ alias: "alpha", connectionState: "connected" }), expect.anything()] }
    });
    first.close();
    await expect(client.callTool({ name: "hosts_list", arguments: {} })).resolves.toMatchObject({
      structuredContent: { hosts: [expect.objectContaining({ alias: "alpha", connectionState: "connected" }), expect.anything()] }
    });
    second.close();
    await expect(client.callTool({ name: "hosts_list", arguments: {} })).resolves.toMatchObject({
      structuredContent: { hosts: [expect.objectContaining({ alias: "alpha", connectionState: "disconnected" }), expect.anything()] }
    });
    await expect(adapter.connect(host)).rejects.toThrow("连接失败");
    expect(registry.list().find((entry) => entry.alias === "alpha")?.connectionState).toBe("disconnected");
  });

  async function connect(registry: HostRegistry): Promise<{ client: Client }> {
    const server = createServer(registry);
    const client = new Client({ name: "contract-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closers.push(async () => {
      await client.close();
      await server.close();
    });
    return { client };
  }
});
