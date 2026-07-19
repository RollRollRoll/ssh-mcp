import type { TransferProgressEvent } from "./file-transfer.js";

export const MAX_TRANSFER_PROGRESS_EVENTS_PER_OPERATION = 4;
const PERIODIC_PROGRESS_EVENTS = MAX_TRANSFER_PROGRESS_EVENTS_PER_OPERATION - 2;

/** 每个执行实例保留独立固定预算：首个、有限进度摘要和最终摘要。 */
export class TransferProgressReporter<T extends TransferProgressEvent> {
  private emittedEvents = 0;
  private emittedPeriodicEvents = 0;
  private lastReportedRatio = -1;
  private finalized = false;

  public constructor(private readonly observer?: (event: T) => void) {}

  public update(event: T): void {
    if (this.observer === undefined || this.finalized) return;
    if (this.emittedEvents === 0) {
      this.emit(event);
      return;
    }
    if (this.emittedPeriodicEvents >= PERIODIC_PROGRESS_EVENTS) return;
    const ratio = progressRatio(event);
    const threshold = (this.emittedPeriodicEvents + 1) / (PERIODIC_PROGRESS_EVENTS + 1);
    if (ratio === undefined || ratio < threshold || ratio <= this.lastReportedRatio) return;
    this.emittedPeriodicEvents += 1;
    this.emit(event, ratio);
  }

  public final(event: T): void {
    if (this.finalized) return;
    this.finalized = true;
    if (this.observer !== undefined && this.emittedEvents < MAX_TRANSFER_PROGRESS_EVENTS_PER_OPERATION) {
      this.emit(event, progressRatio(event));
    }
  }

  private emit(event: T, ratio = progressRatio(event)): void {
    this.observer?.(event);
    this.emittedEvents += 1;
    if (ratio !== undefined) this.lastReportedRatio = Math.max(this.lastReportedRatio, ratio);
  }
}

function progressRatio(event: TransferProgressEvent): number | undefined {
  if (event.totalItems !== undefined && event.totalItems > 0) {
    const currentItem = event.totalBytes !== undefined && event.totalBytes > 0
      ? Math.min(1, event.transferredBytes / event.totalBytes)
      : 0;
    return Math.min(1, (event.completedItems + currentItem) / event.totalItems);
  }
  if (event.totalBytes !== undefined && event.totalBytes > 0) {
    return Math.min(1, event.transferredBytes / event.totalBytes);
  }
  return undefined;
}
