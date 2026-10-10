import type { InvocationEvent } from '@capix/protocol';
import type { ChangeCapture } from '../changes/capture.js';
import { captureChange } from '../changes/publish.js';

import type { InvocationIdentity } from '../observation/facts.js';

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

  publish(change: InvocationEvent['change'], order?: { sequence: number; occurredAt: string }): void {
    const sequence = order?.sequence ?? ++this.#sequence;
    captureChange(this.target, Object.freeze({ type: 'invocation', ...this.identity, sequence, occurredAt: order?.occurredAt ?? new Date().toISOString(), change: Object.freeze({ ...change }) }));
  }
}
