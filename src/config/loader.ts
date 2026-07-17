import { readFileSync } from "node:fs";
import { isAlias, isMap, isNode, isSeq, parseDocument } from "yaml";
import { ConfigSchema, type SshMcpConfig } from "./schema.js";

export class ConfigError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(`配置无效：${message}`, options);
    this.name = "ConfigError";
  }
}

export class ConfigLoader {
  private loaded: SshMcpConfig | undefined;
  private failure: ConfigError | undefined;

  public constructor(
    private readonly configPath: string,
    private readonly readConfig: (path: string) => string = (path) => readFileSync(path, "utf8")
  ) {}

  public load(): SshMcpConfig {
    if (this.loaded !== undefined) {
      return this.loaded;
    }
    if (this.failure !== undefined) {
      throw this.failure;
    }

    try {
      this.loaded = loadConfigFromYaml(this.readConfig(this.configPath));
      return this.loaded;
    } catch (error: unknown) {
      this.failure = error instanceof ConfigError
        ? error
        : new ConfigError(`无法读取 ${this.configPath}`, { cause: error });
      throw this.failure;
    }
  }
}

export function loadConfigFromYaml(source: string): SshMcpConfig {
  try {
    const document = parseDocument(source, {
      version: "1.2",
      customTags: [],
      uniqueKeys: true
    });
    if (document.errors.length > 0) {
      throw new ConfigError(document.errors.map((error) => error.message).join("；"));
    }
    if (document.directives.yaml.version !== "1.2") {
      throw new ConfigError("仅支持 YAML 1.2 文档");
    }

    rejectAliasesAndTags(document.contents);
    const parsed = ConfigSchema.safeParse(document.toJS({ maxAliasCount: 0 }));
    if (!parsed.success) {
      throw new ConfigError(parsed.error.issues.map((issue) => `${issue.path.join(".") || "根对象"}: ${issue.message}`).join("；"));
    }
    return deepFreeze(parsed.data);
  } catch (error: unknown) {
    if (error instanceof ConfigError) {
      throw error;
    }
    throw new ConfigError("YAML 解析失败", { cause: error });
  }
}

function rejectAliasesAndTags(node: unknown): void {
  if (node === null || node === undefined) {
    return;
  }
  if (isAlias(node)) {
    throw new ConfigError("不允许 YAML 别名");
  }
  if (isNode(node) && node.tag !== undefined) {
    throw new ConfigError("不允许 YAML 标签");
  }
  if (isMap(node)) {
    for (const pair of node.items) {
      rejectAliasesAndTags(pair.key);
      rejectAliasesAndTags(pair.value);
    }
  }
  if (isSeq(node)) {
    for (const item of node.items) {
      rejectAliasesAndTags(item);
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
