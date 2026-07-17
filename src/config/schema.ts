import { z } from "zod";

const boundedPathMessage = "必须是不含 .. 的绝对路径";

function isPortableAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
}

function isBoundedAbsolutePath(value: string): boolean {
  return isPortableAbsolutePath(value) && !value.split(/[\\/]+/).includes("..");
}

const boundedAbsolutePath = z.string().min(1).refine(isBoundedAbsolutePath, boundedPathMessage);

const AgentAuthSchema = z.object({
  type: z.literal("agent"),
  socket: boundedAbsolutePath
}).strict();

const PageantAuthSchema = z.object({
  type: z.literal("pageant")
}).strict();

const PrivateKeyFileAuthSchema = z.object({
  type: z.literal("privateKeyFile"),
  path: boundedAbsolutePath
}).strict();

export const AuthSchema = z.discriminatedUnion("type", [
  AgentAuthSchema,
  PageantAuthSchema,
  PrivateKeyFileAuthSchema
]);

const PosixShellSchema = z.object({
  type: z.literal("posix"),
  command: z.string().min(1)
}).strict();

const PowerShellSchema = z.object({
  type: z.literal("powershell"),
  command: z.string().min(1)
}).strict();

export const HostSchema = z.object({
  alias: z.string().min(1),
  environment: z.enum(["development", "test"]),
  platform: z.enum(["linux", "windows"]),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  username: z.string().min(1),
  auth: AuthSchema,
  shell: z.discriminatedUnion("type", [PosixShellSchema, PowerShellSchema]),
  remoteRoots: z.array(boundedAbsolutePath).min(1)
}).strict().superRefine((host, context) => {
  const expectedShell = host.platform === "linux" ? "posix" : "powershell";
  if (host.shell.type !== expectedShell) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["shell", "type"],
      message: `${host.platform} 平台必须使用 ${expectedShell} Shell`
    });
  }
});

const LimitsSchema = z.object({
  connectTimeoutMs: z.number().int().positive().max(60_000).default(15_000),
  commandTimeoutMs: z.number().int().positive().max(1_800_000).default(300_000),
  sessionIdleTimeoutMs: z.number().int().positive().max(28_800_000).default(1_800_000),
  transferTimeoutMs: z.number().int().positive().max(7_200_000).default(1_800_000),
  approvalTimeoutMs: z.number().int().positive().max(600_000).default(120_000),
  cancelConfirmationTimeoutMs: z.number().int().positive().max(60_000).default(10_000),
  outputBufferBytes: z.number().int().positive().max(33_554_432).default(8_388_608),
  resultRetentionMs: z.number().int().positive().max(3_600_000).default(900_000)
}).strict();

const LowRiskParameterSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("enum"), name: z.string().min(1), required: z.boolean(), values: z.array(z.string()).min(1) }).strict(),
  z.object({ type: z.literal("integer"), name: z.string().min(1), required: z.boolean() }).strict(),
  z.object({ type: z.literal("boolean"), name: z.string().min(1), required: z.boolean() }).strict(),
  z.object({ type: z.literal("remotePath"), name: z.string().min(1), required: z.boolean() }).strict()
]);

const LowRiskProfileSchema = z.object({
  id: z.string().min(1),
  hostAliases: z.array(z.string().min(1).refine((alias) => !alias.includes("*"), "不允许通配符")).min(1),
  platform: z.enum(["linux", "windows"]),
  executable: z.string().min(1),
  fixedArgs: z.array(z.string()).default([]),
  parameters: z.array(LowRiskParameterSchema).default([])
}).strict();

export const ConfigSchema = z.object({
  version: z.literal(1),
  trustStore: boundedAbsolutePath,
  localRoots: z.array(boundedAbsolutePath).min(1),
  limits: LimitsSchema.default({
    connectTimeoutMs: 15_000,
    commandTimeoutMs: 300_000,
    sessionIdleTimeoutMs: 1_800_000,
    transferTimeoutMs: 1_800_000,
    approvalTimeoutMs: 120_000,
    cancelConfirmationTimeoutMs: 10_000,
    outputBufferBytes: 8_388_608,
    resultRetentionMs: 900_000
  }),
  hosts: z.array(HostSchema).min(1).max(10),
  lowRiskProfiles: z.array(LowRiskProfileSchema).default([])
}).strict().superRefine((config, context) => {
  const aliases = new Set<string>();
  for (const [index, host] of config.hosts.entries()) {
    if (aliases.has(host.alias)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["hosts", index, "alias"], message: "主机别名必须唯一" });
    }
    aliases.add(host.alias);
  }

  const profileIds = new Set<string>();
  for (const [index, profile] of config.lowRiskProfiles.entries()) {
    if (profileIds.has(profile.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["lowRiskProfiles", index, "id"], message: "低风险规则 ID 必须唯一" });
    }
    profileIds.add(profile.id);
    for (const alias of profile.hostAliases) {
      if (!aliases.has(alias)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["lowRiskProfiles", index, "hostAliases"], message: "低风险规则只能引用登记主机" });
      }
    }
  }
});

export type SshMcpConfig = z.infer<typeof ConfigSchema>;
export type HostConfig = z.infer<typeof HostSchema>;
export type ConnectionState = "connected" | "disconnected" | "unknown";
