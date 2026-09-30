import type { InvocationEvent } from '@capix-observer/protocol';
import type { ChangeCapture } from '../changes/capture.js';
import { captureChange } from '../changes/publish.js';

export interface InvocationIdentity {
  readonly contextId: string;
  readonly level: InvocationEvent['level'];
  readonly parentContextId?: string;
}

/** Per-call event construction and source order; no listeners, records or execution policy. */
export class InvocationChangeEmitter {
  #sequence = 0;
  private readonly identity: InvocationIdentity;

  constructor(
    identity: InvocationIdentity,
    private readonly target: ChangeCapture<InvocationEvent>,
  ) {
    this.identity = Object.freeze({ ...identity });
  }

  publish(change: InvocationEvent['change']): void {
    const sequence = ++this.#sequence;
    captureChange(this.target, Object.freeze({ type: 'invocation', ...this.identity, sequence, occurredAt: new Date().toISOString(), change: Object.freeze({ ...change }) }));
  }
}
