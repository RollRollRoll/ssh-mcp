import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { HostConfig, LowRiskProfile } from "../../src/config/schema.js";
import { PolicyEngine } from "../../src/policy/policy-engine.js";
import { ProfileRemotePathVerifier } from "../../src/policy/profile-remote-path-verifier.js";
import type { SftpTransferSession, SshConnection } from "../../src/ssh/ssh-adapter.js";

const host: HostConfig = {
  alias: "linux", environment: "test", platform: "linux", host: "127.0.0.1", port: 22,
  username: "tester", auth: { type: "pageant" }, shell: { type: "posix", command: "/bin/sh" },
  remoteRoots: ["/safe"]
};
const profile: LowRiskProfile = {
  id: "cat", hostAliases: ["linux"], platform: "linux", executable: "/bin/cat", fixedArgs: [],
  parameters: [{ type: "remotePath", name: "path", required: true }]
};

describe("ProfileRemotePathVerifier", () => {
  it("在同一待执行 SSH 连接逐段验证，根内 symlink 指向根外时关闭失败且不执行命令", async () => {
    const decision = new PolicyEngine([profile]).evaluate({
      profileId: "cat", host, parameters: { path: "/safe/link" }
    });
    expect(decision.matched).toBe(true);
    if (!decision.matched) return;
    let execCalls = 0;
    let sftpCloses = 0;
    const sftp = session({
      "/": { kind: "directory", id: "root", size: 0 },
      "/safe": { kind: "directory", id: "safe", size: 0 },
      "/safe/link": { kind: "symlink", id: "link", size: 0 }
    });
    const connection: SshConnection = {
      exec: () => { execCalls += 1; },
      openShell: () => undefined,
      openSftp: (callback) => callback(undefined, { ...sftp, close: () => { sftpCloses += 1; } }),
      close: () => undefined
    };

    const preflight = new ProfileRemotePathVerifier().create(decision.match);
    await expect(preflight?.(connection)).rejects.toMatchObject({ code: "POLICY_REQUIRES_APPROVAL" });
    expect(execCalls).toBe(0);
    expect(sftpCloses).toBe(1);
  });
});

function session(entries: Readonly<Record<string, { kind: "file" | "directory" | "symlink"; id: string; size: number }>>): SftpTransferSession {
  return {
    lstat: async (path) => {
      const value = entries[path];
      if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return value;
    },
    realpath: async (path) => path,
    createReadStream: () => new PassThrough(),
    createWriteStream: () => new PassThrough(),
    supportsAtomicReplace: false,
    supportsHardlink: false,
    atomicReplace: async () => undefined,
    hardlink: async () => undefined,
    unlink: async () => undefined,
    close: () => undefined
  };
}
