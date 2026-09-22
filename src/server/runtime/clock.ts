import { performance } from 'node:perf_hooks';

/** Wall time for dates; monotonic time for elapsed durations. */
export class Clock {
  now(): string {
    return new Date().toISOString();
  }
  tick(): number {
    return performance.now();
  }
}
