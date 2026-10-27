import { ProgressChannel, type ProgressReceiver } from '@capix/changes';
import type { RunnerObservationEvent } from './observation-contract.js';

export type { RunnerDiagnostic, RunnerEntryFact, RunnerResourceFact, RunnerBusinessFact, RunnerCheckpointChild, RunnerCheckpointFact, RunnerObservationEvent } from './observation-contract.js';

export type RunnerObservationReceiver = ProgressReceiver<RunnerObservationEvent>;

/** Live metadata only. Subscription neither starts execution nor replays earlier facts. */
export interface RunnerObservation {
  subscribe(receiver: RunnerObservationReceiver): () => void;
}

/** Runner-owned publication. One failed consumer cannot disable its peers or the producer. */
export class RunnerObservationSubscriptions {
  readonly #subscribers = new Set<ProgressChannel<RunnerObservationEvent>>();
  readonly port: RunnerObservation = Object.freeze({ subscribe: (receiver: RunnerObservationReceiver) => this.subscribe(receiver) });

  get active(): boolean {
    return this.#subscribers.size > 0;
  }

  publish(event: RunnerObservationEvent): undefined {
    const fixed = Object.freeze({ ...event });
    for (const channel of [...this.#subscribers]) {
      if (!this.#subscribers.has(channel)) continue;
      channel.publish(fixed);
      if (channel.failure) this.#subscribers.delete(channel);
    }
  }

  private subscribe(receiver: RunnerObservationReceiver): () => void {
    if (!receiver || typeof receiver.receive !== 'function' || (receiver.failed !== undefined && typeof receiver.failed !== 'function')) throw new TypeError('Observation subscription requires a synchronous receiver');
    const channel = new ProgressChannel<RunnerObservationEvent>({ receive: receiver.receive.bind(receiver), failed: receiver.failed?.bind(receiver) });
    this.#subscribers.add(channel);
    return () => {
      this.#subscribers.delete(channel);
    };
  }
}
