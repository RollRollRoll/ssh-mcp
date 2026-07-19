import { describe, expect, it } from "vitest";
import { testWithIds } from "../test-with-ids.js";
import {
  createMcpOperationError,
  type McpOperationError
} from "../../src/errors/error-contract.js";
import {
  JsonLogger,
  LogEvents,
  LogStates,
  SecretRedactor,
  type LogContext
} from "../../src/observability/logger.js";

describe("SecretRedactor", () => {
  it("错误 details 默认关闭，仅保留白名单关联字段且在脱敏后深冻结", () => {
    const redactor = new SecretRedactor({
      privateKeyPaths: ["/Users/dev/.ssh/id_ed25519"]
    });
    const digest = "a".repeat(64);

    const error = createMcpOperationError({
      code: "AUTH_FAILED",
      message: [
        "认证失败：Bearer secret-token",
        "publicKey=ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey",
        "identityFile=/Users/dev/.ssh/id_test",
        "sshConfig={Host alpha IdentityFile /Users/dev/.ssh/id_test}",
        "settings={token:settings-token}"
      ].join("; "),
      finalState: "failed",
      retriable: false,
      sideEffects: "none",
      details: {
        reason: "disconnected",
        digest,
        password: "correct-horse-battery-staple",
        privateKeyPath: "/Users/dev/.ssh/id_ed25519",
        privateKey: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
        publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey",
        identityFile: "/Users/dev/.ssh/id_test",
        agentMessage: "agent-packet",
        sshConfig: { auth: { token: "secret-token" } },
        settings: { auth: { token: "settings-token" } },
        nested: { authorization: "Bearer secret-token" }
      }
    }, redactor);

    expect(error.details).toEqual({ reason: "disconnected", digest });
    expect(error.message).toBe("认证失败。");
    expect(Object.isFrozen(error.details)).toBe(true);
    expect(Reflect.set(error.details as Record<string, unknown>, "digest", "injected-after-redaction")).toBe(false);
    expect(JSON.stringify(error)).not.toContain("injected-after-redaction");
    for (const secret of [
      "secret-token",
      "settings-token",
      "AAAAC3NzaC1lZDI1NTE5AAAAITestKey",
      "/Users/dev/.ssh/id_test",
      "Host alpha",
      "correct-horse-battery-staple",
      "agent-packet"
    ]) {
      expect(JSON.stringify(error)).not.toContain(secret);
    }
    for (const key of ["publicKey", "identityFile", "sshConfig", "settings"]) {
      expect(error.details).not.toHaveProperty(key);
    }
  });

  it("最终目标提交证据只保留严格三态，未知提交结果可安全关联", () => {
    const redactor = new SecretRedactor();
    expect(redactor.redact({
      finalTargetCommit: "unknown",
      commitOutcome: "unknown",
      finalTargetCommitted: false
    })).toEqual({ finalTargetCommit: "unknown", commitOutcome: "unknown" });
    expect(redactor.redact({
      finalTargetCommit: "maybe",
      commitOutcome: "committed"
    })).toEqual({});
  });

  it.each([
    ["嵌套 settings", "settings={auth:{token:settings-token-nested}}", "settings-token-nested"],
    ["带空格的 identityFile", "identityFile = /Users/dev/.ssh/identity file", "/Users/dev/.ssh/identity file"],
    ["多段 PEM", "-----BEGIN PRIVATE KEY-----\\nfirst-key\\n-----END PRIVATE KEY-----\\n-----BEGIN PRIVATE KEY-----\\nsecond-key\\n-----END PRIVATE KEY-----", "second-key"],
    ["新的 SSH 密钥类型", "ssh-ed448 AAAAC3NzaC1lZDQ0OQAAAANewKeyMaterial", "AAAAC3NzaC1lZDQ0OQAAAANewKeyMaterial"],
    ["SSH Agent 报文", "agent@openssh.com agent-wire-packet-secret", "agent-wire-packet-secret"]
  ])("调用方 message 含%s时不会进入客户端错误", (_caseName, message, secret) => {
    const error = createMcpOperationError({
      code: "AUTH_FAILED",
      message,
      finalState: "failed",
      retriable: false,
      sideEffects: "none"
    });

    expect(error.message).toBe("认证失败。");
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(message);
  });

  it("非法顶层错误字段采用关闭失败默认，且 message 只由最终 code 决定", () => {
    const secret = "agent-packet-token";
    const error = createMcpOperationError({
      code: "AGENT_PACKET",
      message: secret,
      finalState: `failed_${secret}`,
      retriable: "true",
      sideEffects: `possible_${secret}`,
      operationId: "op-unknown",
      sessionId: "session-unknown",
      host: "alpha"
    } as unknown as McpOperationError);

    expect(error).toEqual({
      code: "INTERNAL_ERROR",
      message: "内部错误。",
      finalState: "failed",
      retriable: false,
      sideEffects: "none"
    });
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("错误关联字段只保留已知 ID 与 allowedHosts 中的原始主机名", () => {
    const knownValues = {
      allowedOperationIds: new Set(["op-known"]),
      allowedSessionIds: new Set(["session-known"]),
      allowedHosts: new Set(["研发_主机 北京"])
    };
    const known = createMcpOperationError({
      code: "AUTH_FAILED",
      message: "不会采用",
      finalState: "failed",
      retriable: false,
      sideEffects: "none",
      operationId: "op-known",
      sessionId: "session-known",
      host: "研发_主机 北京"
    }, new SecretRedactor(), knownValues);
    const unknown = createMcpOperationError({
      code: "AUTH_FAILED",
      message: "不会采用",
      finalState: "failed",
      retriable: false,
      sideEffects: "none",
      operationId: "op-safe-but-unknown",
      sessionId: "session-safe-but-unknown",
      host: "字符安全但未登记"
    }, new SecretRedactor(), knownValues);

    expect(known).toMatchObject({
      operationId: "op-known",
      sessionId: "session-known",
      host: "研发_主机 北京"
    });
    expect(unknown).not.toHaveProperty("operationId");
    expect(unknown).not.toHaveProperty("sessionId");
    expect(unknown).not.toHaveProperty("host");
  });

  it("错误输入的动态 getter 每个只读取一次，并只输出首次快照", () => {
    const reads: Record<string, number> = {};
    const firstValues: Record<string, unknown> = {
      code: "AUTH_FAILED",
      message: "调用方消息",
      finalState: "failed",
      retriable: false,
      sideEffects: "none",
      operationId: "op-known",
      sessionId: "session-known",
      host: "研发_主机 北京",
      details: { reason: "disconnected" }
    };
    const dynamicError = Object.create(null) as Record<string, unknown>;
    for (const [key, firstValue] of Object.entries(firstValues)) {
      Object.defineProperty(dynamicError, key, {
        enumerable: true,
        get: () => {
          reads[key] = (reads[key] ?? 0) + 1;
          return reads[key] === 1 ? firstValue : `Bearer getter-secret-${key}`;
        }
      });
    }

    const error = createMcpOperationError(dynamicError as unknown as McpOperationError, new SecretRedactor(), {
      allowedOperationIds: new Set(["op-known"]),
      allowedSessionIds: new Set(["session-known"]),
      allowedHosts: new Set(["研发_主机 北京"])
    });

    expect(reads).toEqual(Object.fromEntries(Object.keys(firstValues).map((key) => [key, 1])));
    expect(error).toMatchObject({
      code: "AUTH_FAILED",
      message: "认证失败。",
      finalState: "failed",
      retriable: false,
      sideEffects: "none",
      operationId: "op-known",
      sessionId: "session-known",
      host: "研发_主机 北京",
      details: { reason: "disconnected" }
    });
    expect(JSON.stringify(error)).not.toContain("getter-secret");
  });
});

describe("JsonLogger", () => {
  testWithIds(["SC-014"], "只向 stderr sink 写一行 JSON，且永不包含默认禁止的敏感内容", () => {
    const lines: string[] = [];
    const logger = new JsonLogger({
      write: (line) => lines.push(line)
    }, {
      now: () => new Date("2026-07-17T00:00:00.000Z")
    }, new SecretRedactor({
      privateKeyPaths: ["/Users/dev/.ssh/id_ed25519"]
    }), {
      allowedOperationIds: new Set(["op-1"]),
      allowedHosts: new Set(["alpha"])
    });

    const digest = "b".repeat(64);
    logger.info(LogEvents.OPERATION_APPROVAL, {
      operationId: "op-1",
      host: "alpha",
      state: LogStates.AWAITING_APPROVAL,
      durationMs: 12,
      details: {
        digest,
        command: "rm -rf /srv/project",
        terminalInput: "drop database",
        fileContent: "top secret",
        privateKeyPath: "/Users/dev/.ssh/id_ed25519",
        privateKey: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
        publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey",
        identityFile: "/Users/dev/.ssh/id_test",
        agentMessage: "agent packet",
        sshConfig: { hosts: [{ username: "developer" }] },
        settings: { token: "settings-token" },
        authorization: "Bearer auth-token"
      }
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith("\n")).toBe(true);
    expect(() => JSON.parse(lines[0] ?? "")).not.toThrow();
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      timestamp: "2026-07-17T00:00:00.000Z",
      level: "info",
      event: "operation.approval",
      operationId: "op-1",
      host: "alpha",
      state: "awaiting_approval",
      durationMs: 12,
      details: { digest }
    });
    for (const secret of [
      "rm -rf /srv/project",
      "drop database",
      "top secret",
      "id_ed25519",
      "AAAAC3NzaC1lZDI1NTE5AAAAITestKey",
      "/Users/dev/.ssh/id_test",
      "agent packet",
      "settings-token",
      "auth-token"
    ]) {
      expect(lines[0]).not.toContain(secret);
    }
    for (const key of ["publicKey", "identityFile", "sshConfig", "settings"]) {
      expect(lines[0]).not.toContain(key);
    }
  });

  it("拒绝不符合严格格式的 event 与顶层 context，且不会将其写入 stderr", () => {
    const lines: string[] = [];
    const logger = new JsonLogger({
      write: (line) => lines.push(line)
    }, {
      now: () => new Date("2026-07-17T00:00:00.000Z")
    });
    const injected = "Bearer top-level-injected-token";

    logger.error(`agent message ${injected}`, {
      operationId: `op ${injected}`,
      sessionId: `session ${injected}`,
      host: `host ${injected}`,
      state: `state ${injected}`,
      durationMs: Number.NaN,
      errorCode: `AUTH_FAILED ${injected}`
    });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      timestamp: "2026-07-17T00:00:00.000Z",
      level: "error",
      event: "<event-redacted>"
    });
    expect(lines[0]).not.toContain(injected);
  });

  it("event/state/errorCode 只接受受控枚举，字符安全的 token 或 Agent 值也会被拒绝", () => {
    const lines: string[] = [];
    const logger = new JsonLogger({ write: (line) => lines.push(line) }, {
      now: () => new Date("2026-07-17T00:00:00.000Z")
    });

    logger.error("agent.packet" as never, {
      state: "agent_packet",
      errorCode: "AGENT_TOKEN"
    } as never);

    expect(JSON.parse(lines[0] ?? "")).toEqual({
      timestamp: "2026-07-17T00:00:00.000Z",
      level: "error",
      event: "<event-redacted>"
    });
  });

  it("日志只保留已知 ID 与 allowedHosts 中的中文、下划线或空格主机名", () => {
    const lines: string[] = [];
    const logger = new JsonLogger({ write: (line) => lines.push(line) }, {
      now: () => new Date("2026-07-17T00:00:00.000Z")
    }, new SecretRedactor(), {
      allowedOperationIds: new Set(["op-known"]),
      allowedSessionIds: new Set(["session-known"]),
      allowedHosts: new Set(["研发_主机 北京"])
    });

    logger.info(LogEvents.OPERATION_APPROVAL, {
      operationId: "op-known",
      sessionId: "session-known",
      host: "研发_主机 北京",
      state: LogStates.AWAITING_APPROVAL,
      errorCode: "AUTH_FAILED"
    });
    logger.info(LogEvents.OPERATION_APPROVAL, {
      operationId: "op-safe-but-unknown",
      sessionId: "session-safe-but-unknown",
      host: "alpha"
    });

    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      operationId: "op-known",
      sessionId: "session-known",
      host: "研发_主机 北京",
      state: "awaiting_approval",
      errorCode: "AUTH_FAILED"
    });
    expect(JSON.parse(lines[1] ?? "")).toEqual({
      timestamp: "2026-07-17T00:00:00.000Z",
      level: "info",
      event: "operation.approval"
    });
  });

  it("日志 context 动态 getter 每个只读取一次，并只输出首次快照", () => {
    const lines: string[] = [];
    const reads: Record<string, number> = {};
    const firstValues: Record<string, unknown> = {
      operationId: "op-known",
      sessionId: "session-known",
      host: "研发_主机 北京",
      state: "awaiting_approval",
      durationMs: 7,
      errorCode: "AUTH_FAILED",
      details: { digest: "c".repeat(64) }
    };
    const dynamicContext = Object.create(null) as Record<string, unknown>;
    for (const [key, firstValue] of Object.entries(firstValues)) {
      Object.defineProperty(dynamicContext, key, {
        enumerable: true,
        get: () => {
          reads[key] = (reads[key] ?? 0) + 1;
          return reads[key] === 1 ? firstValue : `Bearer getter-secret-${key}`;
        }
      });
    }
    const logger = new JsonLogger({ write: (line) => lines.push(line) }, {
      now: () => new Date("2026-07-17T00:00:00.000Z")
    }, new SecretRedactor(), {
      allowedOperationIds: new Set(["op-known"]),
      allowedSessionIds: new Set(["session-known"]),
      allowedHosts: new Set(["研发_主机 北京"])
    });

    logger.info(LogEvents.OPERATION_APPROVAL, dynamicContext as unknown as LogContext);

    expect(reads).toEqual(Object.fromEntries(Object.keys(firstValues).map((key) => [key, 1])));
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      operationId: "op-known",
      sessionId: "session-known",
      host: "研发_主机 北京",
      state: "awaiting_approval",
      durationMs: 7,
      errorCode: "AUTH_FAILED",
      details: { digest: "c".repeat(64) }
    });
    expect(lines[0]).not.toContain("getter-secret");
  });
});
