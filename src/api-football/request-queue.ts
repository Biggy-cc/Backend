type WaitingRequest = { priority: number; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** Prioritize score refreshes without interrupting a request already in progress. */
export class ProviderRequestQueue {
  private waiting: WaitingRequest[] = [];
  private running = false;
  private lastStartedAt = 0;
  constructor(private readonly gapMs: () => number, private readonly beforeStart: () => void) {}

  get depth(): number { return this.waiting.length; }

  enter(priority = 0, maxWaitMs = 40_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const item: WaitingRequest = { priority, resolve, reject, timer: setTimeout(() => {
        const index = this.waiting.indexOf(item);
        if (index !== -1) {
          this.waiting.splice(index, 1);
          reject(new Error("Football provider queue timed out before the request started"));
        }
      }, maxWaitMs) };
      this.waiting.push(item);
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (this.waiting.length) {
      const wait = this.gapMs() - (Date.now() - this.lastStartedAt);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      if (!this.waiting.length) continue;
      let best = 0;
      for (let i = 1; i < this.waiting.length; i++) {
        if (this.waiting[i].priority > this.waiting[best].priority) best = i;
      }
      const [item] = this.waiting.splice(best, 1);
      clearTimeout(item.timer);
      try {
        this.beforeStart();
        this.lastStartedAt = Date.now();
        item.resolve();
      } catch (error) {
        item.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    this.running = false;
  }
}
