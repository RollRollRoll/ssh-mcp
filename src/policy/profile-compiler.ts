import { isVerifiedProfileMatch, type VerifiedProfileMatch } from "./policy-engine.js";

/** 只接受 PolicyEngine 签发的完整匹配，绝不把任意 MCP 参数送入自动执行编译。 */
export class ProfileCompiler {
  public compile(match: VerifiedProfileMatch): string {
    if (!isVerifiedProfileMatch(match)) throw new Error("未经验证的 Profile 匹配结果");
    return match.profile.platform === "linux" ? this.compileLinux(match) : this.compilePowerShell(match);
  }

  private compileLinux(match: VerifiedProfileMatch): string {
    return [match.profile.executable, ...match.profile.fixedArgs, ...match.values.map(({ value }) => String(value))]
      .map(quotePosix)
      .join(" ");
  }

  private compilePowerShell(match: VerifiedProfileMatch): string {
    if (match.profile.platform !== "windows") throw new Error("Linux Profile 不能使用 PowerShell 编译器");
    return match.profile.commandType === "cmdlet"
      ? this.compilePowerShellCmdlet(match)
      : this.compilePowerShellNative(match);
  }

  private compilePowerShellCmdlet(match: VerifiedProfileMatch): string {
    const values = match.values.flatMap(({ parameter, value }) => parameter.type === "boolean"
      ? [`-${parameter.name}:${value ? "$true" : "$false"}`]
      : [`-${parameter.name}`, quotePowerShell(String(value))]);
    return [
      "&",
      quotePowerShell(match.profile.executable),
      ...match.profile.fixedArgs.map((argument) => isPowerShellParameterToken(argument) ? argument : quotePowerShell(argument)),
      ...values
    ].join(" ");
  }

  private compilePowerShellNative(match: VerifiedProfileMatch): string {
    const values = match.values.flatMap(({ parameter, value }) => [
      quotePowerShell(`-${parameter.name}`),
      quotePowerShell(String(value))
    ]);
    return ["&", quotePowerShell(match.profile.executable), ...match.profile.fixedArgs.map(quotePowerShell), ...values].join(" ");
  }
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function isPowerShellParameterToken(value: string): boolean {
  return /^-[A-Za-z][A-Za-z0-9-]*$/.test(value);
}
