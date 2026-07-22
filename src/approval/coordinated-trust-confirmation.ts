import { ApprovalCoordinator } from "./approval-coordinator.js";
import { createOperationIntent } from "./operation-intent.js";
import type {
  HostKeyVerificationContext,
  TrustConfirmation,
  TrustConfirmationRequest
} from "../ssh/host-key.js";

/** 首次主机信任与普通操作共用审批仲裁器；指纹变化仍在此前由 verifier 直接拒绝。 */
export class CoordinatedTrustConfirmation implements TrustConfirmation {
  public constructor(private readonly coordinator: ApprovalCoordinator) {}

  /** 网页通道始终存在；dual 路由是否同时使用 MCP 由协调器自行判断。 */
  public supportsForm(): boolean {
    return true;
  }

  public async confirm(
    request: TrustConfirmationRequest,
    signal: HostKeyVerificationContext
  ): Promise<"accept" | "decline" | "cancel"> {
    if (signal.aborted || signal.platform === undefined) return "cancel";
    const intent = createOperationIntent({
      kind: "host_trust",
      hosts: [request.alias],
      platformByHost: { [request.alias]: signal.platform },
      payload: {
        algorithm: request.algorithm,
        fingerprint: request.fingerprint
      }
    });
    const pending = this.coordinator.request(intent, () => undefined, {
      route: signal.approvalRoute ?? "dual"
    });
    const cancel = (): void => { this.coordinator.settle(pending.approvalId, "cancel", "mcp"); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      if (signal.aborted) cancel();
      const result = await pending.result;
      return result.approved ? "accept" : "cancel";
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
}
