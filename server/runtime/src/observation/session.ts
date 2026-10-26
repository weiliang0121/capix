import { isUndefined } from 'es-toolkit/predicate';
import type { InvocationObserver } from './observer.js';
import { ObservationError } from './error.js';
import { combineFaults } from '@capix/changes';

export class ObserverSession<Observer extends { available?(): boolean } = InvocationObserver> {
  active = true;
  constructor(
    readonly observer: Observer,
    readonly failure: 'isolate' | 'propagate',
    private readonly invalidated?: (error: unknown) => void,
    private readonly parent?: ObserverSession,
  ) {}
  available(): boolean {
    return this.active && this.parent?.available() !== false && this.observer.available?.() !== false;
  }
  stop(error: unknown): void {
    if (!this.active) return;
    this.active = false;
    this.invalidated?.(error);
  }
  publish(work: (observer: Observer) => unknown): unknown | undefined {
    if (!this.active) return undefined;
    try {
      if (!this.available()) {
        this.active = false;
        return undefined;
      }
      const value = work(this.observer);
      if (value && typeof (value as PromiseLike<unknown>).then === 'function') {
        // Observe a rejected thenable to avoid an unhandled rejection; its work is never accepted.
        Promise.resolve(value).catch(() => {});
        throw new TypeError('Observation must complete synchronously');
      }
      return undefined;
    } catch (cause) {
      this.active = false;
      const error = new ObservationError(cause);
      this.invalidated?.(error);
      return this.failure === 'propagate' ? error : undefined;
    }
  }
}

/** Dispatch continues to healthy peers before reporting a propagation failure. */
export function publishSessions<Observer extends { available?(): boolean }>(sessions: readonly ObserverSession<Observer>[], work: (observer: Observer) => unknown): unknown | undefined {
  const faults: unknown[] = [];
  for (const session of sessions) {
    const fault = session.publish(work);
    if (!isUndefined(fault)) faults.push(fault);
  }
  return combineFaults(faults);
}
