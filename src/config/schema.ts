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

const profileTextMessage = "不得包含 NUL、换行或控制字符";
const safeProfileText = z.string().refine((value) => !/[\u0000-\u001F\u007F]/.test(value), profileTextMessage);
const profileText = z.string().min(1).refine((value) => !/[\u0000-\u001F\u007F]/.test(value), profileTextMessage);
const profileIdentifier = profileText.refine((value) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(value), "必须是安全标识符");

const LowRiskParameterSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("enum"), name: profileIdentifier, required: z.boolean(), values: z.array(safeProfileText).min(1) }).strict(),
  z.object({ type: z.literal("integer"), name: profileIdentifier, required: z.boolean(), minimum: z.number().int().safe().optional(), maximum: z.number().int().safe().optional() }).strict(),
  z.object({ type: z.literal("boolean"), name: profileIdentifier, required: z.boolean() }).strict(),
  z.object({ type: z.literal("remotePath"), name: profileIdentifier, required: z.boolean() }).strict()
]);

const LowRiskProfileFields = {
  id: profileText,
  hostAliases: z.array(profileText.refine((alias) => !alias.includes("*"), "不允许通配符")).min(1),
  executable: profileText,
  fixedArgs: z.array(safeProfileText).default([]),
  parameters: z.array(LowRiskParameterSchema).default([])
};

function validateProfile(profile: {
  hostAliases: readonly string[];
  parameters: readonly z.infer<typeof LowRiskParameterSchema>[];
}, context: z.RefinementCtx): void {
  const aliases = new Set<string>();
  for (const [index, alias] of profile.hostAliases.entries()) {
    if (aliases.has(alias)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["hostAliases", index], message: "Profile 主机别名必须唯一" });
    aliases.add(alias);
  }
  const parameterNames = new Set<string>();
  for (const [index, parameter] of profile.parameters.entries()) {
    if (parameterNames.has(parameter.name)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["parameters", index, "name"], message: "Profile 参数名必须唯一" });
    parameterNames.add(parameter.name);
    if (parameter.type === "integer" && parameter.minimum !== undefined && parameter.maximum !== undefined && parameter.minimum > parameter.maximum) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["parameters", index, "minimum"], message: "minimum 不能大于 maximum" });
    }
    if (parameter.type === "enum" && new Set(parameter.values).size !== parameter.values.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["parameters", index, "values"], message: "枚举值必须唯一" });
    }
  }
}

const powerShellParameterToken = /^-[A-Za-z][A-Za-z0-9-]*$/;

const LinuxLowRiskProfileSchema = z.object({
  ...LowRiskProfileFields,
  platform: z.literal("linux")
}).strict();

const WindowsLowRiskProfileSchema = z.object({
  ...LowRiskProfileFields,
  platform: z.literal("windows"),
  commandType: z.enum(["cmdlet", "native"])
}).strict();

const LowRiskProfileSchema = z.discriminatedUnion("platform", [
  LinuxLowRiskProfileSchema,
  WindowsLowRiskProfileSchema
]).superRefine((profile, context) => {
  validateProfile(profile, context);
  if (profile.platform !== "windows" || profile.commandType !== "cmdlet") return;

  for (const [index, argument] of profile.fixedArgs.entries()) {
    if (argument.startsWith("-") && !powerShellParameterToken.test(argument)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fixedArgs", index],
        message: "Windows Cmdlet 的固定参数必须是无值的 -Name 形式；值必须作为独立固定参数"
      });
    }
  }
});

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
  const hostsByAlias = new Map<string, HostConfig>();
  for (const [index, host] of config.hosts.entries()) {
    if (hostsByAlias.has(host.alias)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["hosts", index, "alias"], message: "主机别名必须唯一" });
    }
    hostsByAlias.set(host.alias, host);
  }

  const profileIds = new Set<string>();
  for (const [index, profile] of config.lowRiskProfiles.entries()) {
    if (profileIds.has(profile.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["lowRiskProfiles", index, "id"], message: "低风险规则 ID 必须唯一" });
    }
    profileIds.add(profile.id);
    for (const alias of profile.hostAliases) {
      const host = hostsByAlias.get(alias);
      if (host === undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["lowRiskProfiles", index, "hostAliases"], message: "低风险规则只能引用登记主机" });
        continue;
      }
      const expectedShell = profile.platform === "linux" ? "posix" : "powershell";
      if (host.platform !== profile.platform) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["lowRiskProfiles", index, "hostAliases"], message: "低风险规则主机平台必须与规则平台一致" });
      }
      if (host.shell.type !== expectedShell) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["lowRiskProfiles", index, "hostAliases"], message: "低风险规则主机 Shell 必须与规则平台一致" });
      }
    }
  }
});

export type SshMcpConfig = z.infer<typeof ConfigSchema>;
export type HostConfig = z.infer<typeof HostSchema>;
export type LowRiskProfile = SshMcpConfig["lowRiskProfiles"][number];
export type LowRiskParameter = LowRiskProfile["parameters"][number];
export type ConnectionState = "connected" | "disconnected" | "unknown";
