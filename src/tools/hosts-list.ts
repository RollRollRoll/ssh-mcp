import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HostRegistry } from "../hosts/host-registry.js";

const HostsListInputSchema = z.object({}).strict();
const HostsListOutputSchema = z.object({
  hosts: z.array(z.object({
    alias: z.string(),
    environment: z.enum(["development", "test"]),
    platform: z.enum(["linux", "windows"]),
    shell: z.enum(["posix", "powershell"]),
    connectionState: z.enum(["connected", "disconnected", "unknown"])
  }))
});

export function registerHostsListTool(server: McpServer, registry: HostRegistry): void {
  server.registerTool("hosts_list", {
    description: "按别名字典序列出登记主机的公开连接状态",
    inputSchema: HostsListInputSchema,
    outputSchema: HostsListOutputSchema
  }, () => {
    const structuredContent = { hosts: registry.list() };
    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent
    };
  });
}
