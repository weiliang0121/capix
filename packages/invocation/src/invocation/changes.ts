import type { InvocationEvent } from '../events.js';
import type { ChangeCapture } from '@weiliang0121/capix-changes';
import { captureChange } from '@weiliang0121/capix-changes';

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
