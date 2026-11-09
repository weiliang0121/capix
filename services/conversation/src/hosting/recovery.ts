import type { ConversationRecoveryActivity, ConversationRecoveryEvent } from '@weiliang0121/capix-protocol';
import type { RunnerObservation, RunnerObservationEvent } from '@weiliang0121/capix-runtime';

/** A bounded, process-local explanation of resumed activity. No old records are invented. */
export class RecoveryActivity {
  readonly #events: ConversationRecoveryEvent[] = [];
  #complete = true;
  readonly #unsubscribe: () => void;

  constructor(observation: RunnerObservation) {
    this.#unsubscribe = observation.subscribe({
      receive: (event) => this.receive(event),
      failed: () => {
        this.#complete = false;
        return undefined;
      },
    });
  }

  snapshot(): ConversationRecoveryActivity {
    return Object.freeze({ complete: this.#complete, events: Object.freeze([...this.#events]) });
  }

  close(): void {
    this.#unsubscribe();
  }

  private receive(event: RunnerObservationEvent): undefined {
    if (event.source !== 'checkpoint' || !event.fact.recovering) return undefined;
    const fact = event.fact;
    this.#events.push(Object.freeze({ entryId: event.entryId, activityId: fact.activityId, contextId: fact.contextId, ...(fact.owner.parentContextId ? { parentContextId: fact.owner.parentContextId } : {}), structureKind: fact.owner.kind, sequence: fact.sequence, occurredAt: fact.occurredAt, kind: fact.kind, ...('point' in fact ? { point: fact.point } : {}), ...('stage' in fact ? { stage: fact.stage } : {}), ...('status' in fact ? { status: fact.status } : {}) }));
    if (this.#events.length > 1024) {
      this.#events.shift();
      this.#complete = false;
    }
    return undefined;
  }
}
