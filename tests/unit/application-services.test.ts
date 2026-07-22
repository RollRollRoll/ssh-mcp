import { describe, expect, it } from "vitest";
import { ApprovalCoordinator, type ApprovalClock } from "../../src/approval/approval-coordinator.js";
import { ApprovalService } from "../../src/approval/approval-service.js";
import { CoordinatedTrustConfirmation } from "../../src/approval/coordinated-trust-confirmation.js";
import { CommandApplicationService, ApplicationServiceError } from "../../src/application/command-application-service.js";
import { ProfileApplicationService } from "../../src/application/profile-application-service.js";
import { CommandRunner } from "../../src/commands/command-runner.js";
import type { HostConfig, LowRiskProfile } from "../../src/config/schema.js";
import { HostRegistry } from "../../src/hosts/host-registry.js";
import { OperationManager, type MonotonicClock } from "../../src/operations/operation-manager.js";
import { PolicyEngine } from "../../src/policy/policy-engine.js";
import type { ApprovalRoute } from "../../src/approval/approval-coordinator.js";
import { StrictHostKeyVerifier, type HostKeyVerificationContext } from "../../src/ssh/host-key.js";

class Clock implements MonotonicClock, ApprovalClock {
  public now(): number { return 0; }
  public setTimeout(): number { return 1; }
  public clearTimeout(): void {}
}

const linux: HostConfig = {
  alias: "linux", environment: "test", platform: "linux", host: "127.0.0.1", port: 22,
  username: "tester", auth: { type: "pageant" }, shell: { type: "posix", command: "/bin/sh" },
  remoteRoots: ["/srv/project"]
};

const profiles: readonly LowRiskProfile[] = [{
  id: "du", hostAliases: ["linux"], platform: "linux", executable: "/usr/bin/du", fixedArgs: ["-s"],
  parameters: [{ type: "remotePath", name: "path", required: true }]
}];

describe("CommandApplicationService", () => {
  it("网页预览冻结完整 Unicode Intent，使用 web_only 且接受前零连接", async () => {
    const clock = new Clock();
    const operations = new OperationManager({ clock, idFactory: () => "web-operation" });
    let elicitationCalls = 0;
    const approval = new ApprovalService({
      supportsFormElicitation: () => true,
      elicit: async () => { elicitationCalls += 1; return { action: "accept" }; }
    }, clock, 100, operations, undefined, new ApprovalCoordinator({
      client: {
        supportsFormElicitation: () => true,
        elicit: async () => { elicitationCalls += 1; return { action: "accept" }; }
      },
      clock,
      idFactory: () => "web-approval"
    }));
    const routes: ApprovalRoute[] = [];
    const runner = new CommandRunner({
      connect: async (_host, _timeout, route) => {
        routes.push(route ?? "dual");
        return await new Promise<never>(() => undefined);
      }
    }, operations);
    const service = new CommandApplicationService(new HostRegistry([linux]), approval, runner);
    const command = "printf '中文'\n$HOME; echo \"原样\"";
    const preview = service.preview({ host: "linux", command });

    expect(preview.approval).toMatchObject({ route: "web_only", state: "pending", kind: "raw_command" });
    expect(preview.intent.payload).toEqual({ command });
    expect(Object.isFrozen(preview.intent)).toBe(true);
    expect(elicitationCalls).toBe(0);
    expect(routes).toEqual([]);
    try {
      service.preview({ host: "missing", command: "true" });
      throw new Error("预期未知主机被拒绝");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ApplicationServiceError);
      expect((error as ApplicationServiceError).error.code).toBe("HOST_NOT_REGISTERED");
    }

    approval.coordinator.decide(preview.approvalId, "accept");
    await expect(preview.result).resolves.toMatchObject({ approved: true, value: { state: "running" } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(routes).toEqual(["web_only"]);
    expect(operations.describeForConsole("web-operation")).toMatchObject({ source: "web", kind: "command" });
    approval.shutdown();
  });

  it("网页来源拒绝多主机，MCP 来源明确传播 dual", async () => {
    const clock = new Clock();
    const operations = new OperationManager({ clock, idFactory: () => "mcp-operation" });
    const routes: ApprovalRoute[] = [];
    const approval = new ApprovalService({
      supportsFormElicitation: () => true,
      elicit: async () => ({ action: "accept" })
    }, clock, 100, operations);
    const runner = new CommandRunner({
      connect: async (_host, _timeout, route) => {
        routes.push(route ?? "dual");
        return await new Promise<never>(() => undefined);
      }
    }, operations);
    const service = new CommandApplicationService(new HostRegistry([linux]), approval, runner);

    await expect(service.execute({ source: "web", hosts: ["linux", "linux-2"], command: "true" }))
      .resolves.toMatchObject({ approved: false, error: { code: "INVALID_ARGUMENT" } });
    await expect(service.execute({ source: "mcp", hosts: ["linux"], command: "true" }))
      .resolves.toMatchObject({ approved: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(routes).toEqual(["dual"]);
    approval.shutdown();
  });
});

describe("ProfileApplicationService", () => {
  it("MCP 保持完整匹配自动执行，网页展示实际编译命令并增加 web_only 审批", async () => {
    const clock = new Clock();
    const ids = ["mcp-profile", "web-profile"];
    const operations = new OperationManager({ clock, idFactory: () => ids.shift()! });
    const routes: ApprovalRoute[] = [];
    const runner = new CommandRunner({
      connect: async (_host, _timeout, route) => {
        routes.push(route ?? "dual");
        return await new Promise<never>(() => undefined);
      }
    }, operations);
    const approval = new ApprovalService({
      supportsFormElicitation: () => true,
      elicit: async () => ({ action: "accept" })
    }, clock, 100, operations, undefined, new ApprovalCoordinator({
      client: { supportsFormElicitation: () => true, elicit: async () => ({ action: "accept" }) },
      clock,
      idFactory: () => "profile-approval"
    }));
    const service = new ProfileApplicationService(
      new HostRegistry([linux]), new PolicyEngine(profiles), runner, approval
    );
    const input = { profileId: "du", parameters: { path: "/srv/project/a b" } };

    expect(service.list()).toEqual([{
      id: "du", platform: "linux", hostAliases: ["linux"],
      parameters: [{ type: "remotePath", name: "path", required: true }]
    }]);
    expect(JSON.stringify(service.list())).not.toContain("/usr/bin/du");

    expect(service.runMcp({ ...input, hosts: ["linux"] })).toMatchObject({ operationId: "mcp-profile", state: "running" });
    const preview = service.preview({ ...input, host: "linux" });
    expect(preview.intent.payload).toEqual({
      profileId: "du", parameters: { path: "/srv/project/a b" }, command: "'/usr/bin/du' '-s' '/srv/project/a b'"
    });
    expect(preview.approval.route).toBe("web_only");
    expect(routes).toEqual([]);
    approval.coordinator.decide(preview.approvalId, "accept");
    await expect(preview.result).resolves.toMatchObject({ approved: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(routes).toEqual(["dual", "web_only"]);
    expect(operations.describeForConsole("mcp-profile")).toMatchObject({ source: "mcp", kind: "profile" });
    expect(operations.describeForConsole("web-profile")).toMatchObject({ source: "web", kind: "profile" });
    approval.shutdown();
  });
});

describe("CoordinatedTrustConfirmation", () => {
  it("首次 TOFU 使用调用来源路由，安全视图不展开主机 endpoint", async () => {
    const clock = new Clock();
    let elicitationCalls = 0;
    const coordinator = new ApprovalCoordinator({
      client: {
        supportsFormElicitation: () => true,
        elicit: async () => { elicitationCalls += 1; return { action: "accept" }; }
      },
      clock,
      idFactory: () => "trust-approval"
    });
    const confirmation = new CoordinatedTrustConfirmation(coordinator);
    const controller = new AbortController();
    const signal = controller.signal as HostKeyVerificationContext;
    signal.approvalRoute = "web_only";
    signal.platform = "linux";
    const pending = confirmation.confirm({
      alias: "linux", host: "secret.internal", port: 2222,
      algorithm: "ssh-ed25519", fingerprint: "SHA256:abc"
    }, signal);
    const approval = coordinator.get("trust-approval");
    expect(approval).toMatchObject({ route: "web_only", kind: "host_trust", hosts: ["linux"] });
    expect(JSON.stringify(approval)).not.toContain("secret.internal");
    expect(elicitationCalls).toBe(0);
    coordinator.decide("trust-approval", "accept");
    await expect(pending).resolves.toBe("accept");
    coordinator.shutdown();
  });

  it("StrictHostKeyVerifier 将 web_only 与平台传播到实际确认 signal", async () => {
    let observed: HostKeyVerificationContext | undefined;
    const verifier = new StrictHostKeyVerifier({
      lookup: async () => undefined,
      remember: async () => undefined
    } as never, {
      supportsForm: () => true,
      confirm: async (_request, signal) => {
        observed = signal;
        return "cancel";
      }
    });
    const controller = new AbortController();
    const signal = controller.signal as HostKeyVerificationContext;
    signal.approvalRoute = "web_only";
    signal.platform = "windows";

    await expect(verifier.verify(
      { alias: "windows", host: "hidden", port: 22 }, hostKey(), signal
    )).rejects.toMatchObject({ code: "HOST_KEY_REJECTED" });
    expect(observed).toMatchObject({ approvalRoute: "web_only", platform: "windows" });
  });
});

function hostKey(): Buffer {
  const algorithm = Buffer.from("ssh-ed25519");
  const key = Buffer.alloc(4 + algorithm.length + 4);
  key.writeUInt32BE(algorithm.length, 0);
  algorithm.copy(key, 4);
  return key;
}
