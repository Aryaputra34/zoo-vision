/** What `data.changed` carries: which cameras, use cases and kinds of data an ingest commit touched. */
export type DataChanged = {
  cameraIds: string[];
  useCases: string[];
  shapes: ('event' | 'interval' | 'metric')[];
};

const union = <T extends string>(a: T[], b: T[]): T[] =>
  [...new Set([...a, ...b])].sort();

/**
 * Limits `data.changed` to one message per window. The first change after a quiet window goes
 * out at once; changes arriving inside the window are merged (set unions) and go out as one
 * message when it ends, which opens the next window. A window that ends with nothing waiting is
 * quiet again.
 */
export class ChangeMerger {
  private timer: NodeJS.Timeout | null = null;
  private pending: DataChanged | null = null;

  constructor(
    private readonly windowMs: number,
    private readonly emit: (change: DataChanged) => void,
  ) {}

  add(change: DataChanged): void {
    if (this.timer) {
      this.pending = this.pending
        ? {
            cameraIds: union(this.pending.cameraIds, change.cameraIds),
            useCases: union(this.pending.useCases, change.useCases),
            shapes: union(this.pending.shapes, change.shapes),
          }
        : sorted(change);
      return;
    }
    this.openWindow();
    this.send(sorted(change));
  }

  /** Stops the timer and drops what is waiting (the server is going away). */
  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }

  private openWindow(): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      const waiting = this.pending;
      this.pending = null;
      if (waiting) {
        this.openWindow();
        this.send(waiting);
      }
    }, this.windowMs);
    this.timer.unref();
  }

  private send(change: DataChanged): void {
    try {
      this.emit(change);
    } catch {
      // the caller logs what it can; a failed send must not leave the merger stuck
    }
  }
}

const sorted = (c: DataChanged): DataChanged => ({
  cameraIds: union(c.cameraIds, []),
  useCases: union(c.useCases, []),
  shapes: union(c.shapes, []),
});
