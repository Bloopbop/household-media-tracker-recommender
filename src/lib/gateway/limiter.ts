// Paces requests to one service: a minimum gap between request starts, a cap
// on requests in flight, and a pause that doubles after each "slow down"
// answer (HTTP 429), up to 15 minutes.

export const MAX_BACKOFF_MS = 15 * 60 * 1000;
const FIRST_BACKOFF_MS = 2000;

export class Limiter {
  private active = 0;
  private nextStart = 0;
  private pausedUntil = 0;
  private backoffMs = 0;
  private readonly waiting: Array<() => void> = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly gapMs: number,
    private readonly maxInFlight: number,
    // A steady clock: pacing must not stall if the device's wall clock jumps.
    private readonly now: () => number = () => performance.now(),
  ) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waiting.push(() => {
        task()
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            this.pump();
          });
      });
      this.pump();
    });
  }

  /** Call after a 429 answer. Honors the service's own wait if it gave one. */
  slowDown(retryAfterMs = 0): number {
    this.backoffMs = Math.min(Math.max(this.backoffMs * 2, FIRST_BACKOFF_MS), MAX_BACKOFF_MS);
    const wait = Math.min(Math.max(this.backoffMs, retryAfterMs), MAX_BACKOFF_MS);
    this.pausedUntil = this.now() + wait;
    return wait;
  }

  /** Call after a normal answer: the next 429 starts the backoff afresh. */
  recovered(): void {
    this.backoffMs = 0;
  }

  get pending(): number {
    return this.waiting.length + this.active;
  }

  private pump(): void {
    if (this.timer) return;
    while (this.waiting.length > 0 && this.active < this.maxInFlight) {
      const wait = Math.max(this.nextStart, this.pausedUntil) - this.now();
      if (wait > 0) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.pump();
        }, wait);
        return;
      }
      const start = this.waiting.shift();
      if (!start) return;
      this.active++;
      this.nextStart = this.now() + this.gapMs;
      start();
    }
  }
}

/** Seconds or an HTTP date, as servers send in Retry-After. */
export function retryAfterMs(header: string | null, now = Date.now()): number {
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}
