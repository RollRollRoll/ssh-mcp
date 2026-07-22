import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const coordinatorModuleUrl = pathToFileURL(resolve("dist/approval/approval-coordinator.js")).href;
const serviceModuleUrl = pathToFileURL(resolve("dist/approval/approval-service.js")).href;
const intentModuleUrl = pathToFileURL(resolve("dist/approval/operation-intent.js")).href;
const intentSource = `createOperationIntent({
  kind: "raw_command",
  hosts: ["alpha"],
  platformByHost: { alpha: "linux" },
  payload: { command: "true" }
})`;

describe("审批默认时钟不会阻止进程自然退出", () => {
  it("pending deadline 不会在未调用 ApprovalCoordinator.shutdown 时保持子进程", async () => {
    const result = await runChild(`
      import { ApprovalCoordinator } from ${JSON.stringify(coordinatorModuleUrl)};
      import { createOperationIntent } from ${JSON.stringify(intentModuleUrl)};
      const client = {
        supportsFormElicitation: () => false,
        elicit: async () => ({ action: "cancel" })
      };
      const coordinator = new ApprovalCoordinator({ client });
      coordinator.request(${intentSource}, () => undefined, { route: "web_only" });
    `);

    expect(result).toEqual({ code: 0, signal: null, stderr: "" });
  });

  it("resolved retention timer 不会在未调用 ApprovalService.shutdown 时保持子进程", async () => {
    const result = await runChild(`
      import { ApprovalService } from ${JSON.stringify(serviceModuleUrl)};
      import { createOperationIntent } from ${JSON.stringify(intentModuleUrl)};
      const client = {
        supportsFormElicitation: () => true,
        elicit: async () => ({ action: "decline" })
      };
      const service = new ApprovalService(client);
      await service.execute(${intentSource}, () => undefined);
    `);

    expect(result).toEqual({ code: 0, signal: null, stderr: "" });
  });
});

async function runChild(source: string): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}> {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const closed = new Promise<void>((resolveClosed) => { child.once("close", () => resolveClosed()); });
  let exitedNaturally = false;

  try {
    return await new Promise((resolveResult, reject) => {
      const watchdog = setTimeout(() => {
        reject(new Error("审批 timer 阻止子进程在 1500ms 内自然退出"));
      }, 1_500);
      child.once("error", (error) => {
        clearTimeout(watchdog);
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(watchdog);
        exitedNaturally = true;
        resolveResult({ code, signal, stderr });
      });
    });
  } finally {
    if (!exitedNaturally) {
      child.kill("SIGKILL");
      await closed;
    }
  }
}
