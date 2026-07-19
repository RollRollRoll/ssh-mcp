import { it } from "vitest";

export type ExecutableTestId = `SC-${string}` | `MN-${string}` | "SAFE-APPROVAL-001";
type TestBody = () => unknown | Promise<unknown>;

/**
 * 把规格 ID 作为真实 Vitest 注册调用的独立字面量参数，而不是标题附近的自由文本。
 * coverage 只认可这个函数的首参数，注释、普通字符串和测试体文本都不会形成覆盖。
 */
export function testWithIds(ids: readonly ExecutableTestId[], title: string, body: TestBody): void {
  it(`${ids.join(" ")}：${title}`, body);
}

export namespace testWithIds {
  export function skipIf(condition: boolean): (
    ids: readonly ExecutableTestId[],
    title: string,
    body: TestBody
  ) => void {
    return (ids, title, body) => {
      it.skipIf(condition)(`${ids.join(" ")}：${title}`, body);
    };
  }
}
