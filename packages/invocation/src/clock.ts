/** Wall time for dates; monotonic time for elapsed durations. */
export class Clock {
  now(): string {
    return new Date().toISOString();
  }
  tick(): number {
    return globalThis.performance.now();
  }
}
