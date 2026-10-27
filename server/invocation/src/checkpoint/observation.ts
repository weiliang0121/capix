import type { MemoryEvent, TranscriptEvent } from '@capix/protocol';
import type { InvocationFact, ResourceObservation } from '../observation/facts.js';
import { InvocationObservation } from '../observation/invocation.js';
import { ObservationError } from '../observation/error.js';

type CheckpointActivityEvent = { kind: 'activity'; fact: InvocationFact } | { kind: 'resource'; fact: ResourceObservation } | { kind: 'transcript'; fact: TranscriptEvent } | { kind: 'memory'; fact: MemoryEvent };

/** Recovery forwards every actual fact. The checkpoint owns each consumer's failure lifetime. */
export class CheckpointObservation extends InvocationObservation {
  constructor(private readonly emit: (event: CheckpointActivityEvent) => void) {
    super([], new Map());
  }

  override publish(fact: InvocationFact): unknown | undefined {
    return this.forward({ kind: 'activity', fact });
  }

  override readonly resource = { publish: (fact: ResourceObservation): unknown | undefined => this.forward({ kind: 'resource', fact }) };
  override readonly transcript = { publish: (fact: TranscriptEvent): unknown | undefined => this.forward({ kind: 'transcript', fact }) };
  override readonly memory = { publish: (fact: MemoryEvent): unknown | undefined => this.forward({ kind: 'memory', fact }) };

  private forward(event: CheckpointActivityEvent): unknown | undefined {
    try {
      this.emit(event);
      return undefined;
    } catch (cause) {
      // Preserve the former recovery-session error boundary without disabling passive forwarding.
      return new ObservationError(cause);
    }
  }
}
