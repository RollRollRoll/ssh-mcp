import { createHash, timingSafeEqual } from "node:crypto";
import { TextDecoder } from "node:util";
import { ErrorCodes, type ErrorCode } from "../errors/error-codes.js";
import {
  TrustStore,
  TrustStoreConflictError,
  type PublicHostKey,
  type TrustIdentity
} from "./trust-store.js";

export const HOST_CONFIRMATION_TIMEOUT_MS = 120_000;

export interface HostKeyTarget {
  readonly alias: string;
  readonly host: string;
  readonly port: number;
}

export interface HostKeyVerificationContext extends AbortSignal {
  onConfirmationStart?: () => boolean;
  onConfirmationEnd?: () => boolean;
}

export interface TrustConfirmationRequest extends HostKeyTarget {
  readonly algorithm: string;
  readonly fingerprint: string;
}

export interface TrustConfirmation {
  supportsForm(): boolean;
  confirm(
    request: TrustConfirmationRequest,
    signal: AbortSignal
  ): Promise<"accept" | "decline" | "cancel">;
}

export interface HostKeyClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

export class HostKeyVerificationError extends Error {
  public constructor(
    public readonly code: ErrorCode,
    public readonly details?: Readonly<Record<string, string>>
  ) {
    super(code);
    this.name = "HostKeyVerificationError";
  }
}

const systemClock: HostKeyClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout)
};

export function describeHostKey(rawKey: Buffer): PublicHostKey {
  if (rawKey.length < 5) {
    throw new Error("主机密钥格式无效");
  }
  const algorithmLength = rawKey.readUInt32BE(0);
  if (algorithmLength === 0 || algorithmLength > rawKey.length - 4) {
    throw new Error("主机密钥格式无效");
  }
  let algorithm: string;
  try {
    algorithm = new TextDecoder("utf-8", { fatal: true }).decode(rawKey.subarray(4, 4 + algorithmLength));
  } catch {
    throw new Error("主机密钥格式无效");
  }
  if (!/^[\x21-\x7e]+$/.test(algorithm)) {
    throw new Error("主机密钥格式无效");
  }
  return Object.freeze({
    algorithm,
    fingerprint: `SHA256:${createHash("sha256").update(rawKey).digest("base64").replace(/=+$/, "")}`,
    rawKey: Buffer.from(rawKey)
  });
}

export class StrictHostKeyVerifier {
  public constructor(
    private readonly trustStore: TrustStore,
    private readonly confirmation: TrustConfirmation,
    private readonly clock: HostKeyClock = systemClock
  ) {}

  public async verify(target: HostKeyTarget, rawKey: Buffer, signal?: HostKeyVerificationContext): Promise<void> {
    rejectIfAborted(signal);
    let candidate: PublicHostKey;
    try {
      candidate = describeHostKey(rawKey);
    } catch {
      throw new HostKeyVerificationError(ErrorCodes.HOST_KEY_REJECTED);
    }
    const identity = toIdentity(target);
    const trusted = await this.trustStore.lookup(identity);
    rejectIfAborted(signal);
    if (trusted !== undefined) {
      if (trusted.rawKey.length === candidate.rawKey.length
        && timingSafeEqual(trusted.rawKey, candidate.rawKey)) {
        return;
      }
      throw changedError(trusted.fingerprint, candidate.fingerprint);
    }
    rejectIfAborted(signal);
    if (!this.confirmation.supportsForm()) {
      throw new HostKeyVerificationError(ErrorCodes.HOST_KEY_REJECTED);
    }
    rejectIfAborted(signal);
    let accepted: boolean;
    if (signal?.onConfirmationStart !== undefined && !signal.onConfirmationStart()) {
      rejectIfAborted(signal);
      throw new HostKeyVerificationError(ErrorCodes.HOST_KEY_REJECTED);
    }
    try {
      accepted = await this.requestConfirmation({
        alias: target.alias,
        host: target.host,
        port: target.port,
        algorithm: candidate.algorithm,
        fingerprint: candidate.fingerprint
      }, signal);
    } finally {
      signal?.onConfirmationEnd?.();
    }
    try {
      rejectIfAborted(signal);
      if (!accepted) {
        throw new HostKeyVerificationError(ErrorCodes.HOST_KEY_REJECTED);
      }
      rejectIfAborted(signal);
      await this.trustStore.remember(identity, candidate, signal);
      rejectIfAborted(signal);
    } catch (error: unknown) {
      rejectIfAborted(signal);
      if (error instanceof TrustStoreConflictError) {
        throw changedError(error.trusted.fingerprint, candidate.fingerprint);
      }
      throw error;
    }
  }

  private async requestConfirmation(request: TrustConfirmationRequest, signal?: HostKeyVerificationContext): Promise<boolean> {
    if (signal?.aborted) return false;
    const controller = new AbortController();
    let cancel: (() => void) | undefined;
    const cancelled = new Promise<boolean>((resolve) => {
      cancel = () => {
        controller.abort();
        resolve(false);
      };
      if (signal?.aborted) {
        cancel();
      } else {
        signal?.addEventListener("abort", cancel, { once: true });
      }
    });
    let timer: unknown;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = this.clock.setTimeout(() => {
        controller.abort();
        resolve(false);
      }, HOST_CONFIRMATION_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([
        this.confirmation.confirm(request, controller.signal).then((value) => value === "accept", () => false),
        timedOut,
        cancelled
      ]);
      return !signal?.aborted && result;
    } catch {
      return false;
    } finally {
      this.clock.clearTimeout(timer);
      if (cancel !== undefined) signal?.removeEventListener("abort", cancel);
    }
  }
}

function rejectIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new HostKeyVerificationError(ErrorCodes.HOST_KEY_REJECTED);
  }
}

function toIdentity(target: HostKeyTarget): TrustIdentity {
  return { alias: target.alias, configuredHost: target.host, port: target.port };
}

function changedError(oldFingerprint: string, newFingerprint: string): HostKeyVerificationError {
  return new HostKeyVerificationError(ErrorCodes.HOST_KEY_CHANGED, { oldFingerprint, newFingerprint });
}
