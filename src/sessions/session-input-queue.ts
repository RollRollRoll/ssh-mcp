/**
 * 单会话输入动作按提交顺序串行。审批等待也在任务内部，因此后来的输入不能越过它。
 */
export class SessionInputQueue {
  private tail: Promise<void> = Promise.resolve();

  public enqueue<T>(action: () => Promise<T> | T): Promise<T> {
    const next = this.tail.then(action, action);
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }
}
