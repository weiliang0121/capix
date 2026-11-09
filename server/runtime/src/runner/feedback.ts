import { randomUUID } from 'node:crypto';
import { ProgressChannel, type ProgressReceiver } from '@weiliang0121/capix-changes';
import type { InvocationIdentity } from '@weiliang0121/capix-contracts';
import type { Clock } from '@weiliang0121/capix-invocation';
import type { CallableFeedback } from '../construction/feedback.js';
import type { EntryChange } from '../entry.js';
import { RunnerObservationSubscriptions } from './observation.js';
import type { RunnerEntryFact } from './observation-contract.js';
import { projectInvocation, projectResource, projectBusiness, projectCheckpoint, projectDiagnostic } from './observation-projection.js';

type EntryUpdate = Exclude<EntryChange, { kind: 'established' }> | { kind: 'requested'; mode: 'run' | 'resume'; requestedContextId?: string } | { kind: 'attached'; identity: InvocationIdentity } | { kind: 'settled'; status: 'succeeded' | 'failed' | 'cancelled'; error?: unknown };

/** A fixed feedback association, not an execution owner or a second copy of call state. */
export class RunnerEntryFeedback {
  readonly id = randomUUID();
  #sequence = 0;
  readonly #entries: ProgressChannel<EntryUpdate>;
  readonly created: ProgressReceiver<InvocationIdentity>;

  constructor(
    private readonly runnerId: string,
    private readonly subscriptions: RunnerObservationSubscriptions,
    private readonly clock: Clock,
  ) {
    this.#entries = new ProgressChannel({ receive: (change) => this.publishEntry(change) });
    this.created = Object.freeze({
      receive: (identity: InvocationIdentity): undefined => {
        this.#entries.publish({ kind: 'attached', identity });
      },
    });
  }

  requested(mode: 'run' | 'resume', requestedContextId?: string): void {
    this.#entries.publish({ kind: 'requested', mode, ...(requestedContextId !== undefined ? { requestedContextId } : {}) });
  }

  entry(change: EntryChange): void {
    if (change.kind !== 'established') this.#entries.publish(change);
  }

  settled(status: 'succeeded' | 'failed' | 'cancelled', error?: unknown): void {
    this.#entries.publish({ kind: 'settled', status, error });
  }

  receivers(signal: AbortSignal): CallableFeedback {
    return Object.freeze({
      invocation: {
        receive: (fact: Parameters<typeof projectInvocation>[0]): undefined => {
          if (this.subscriptions.active) this.subscriptions.publish({ runnerId: this.runnerId, entryId: this.id, source: 'invocation', fact: projectInvocation(fact, signal) });
        },
      },
      resource: {
        receive: (fact: Parameters<typeof projectResource>[0]): undefined => {
          if (this.subscriptions.active) this.subscriptions.publish({ runnerId: this.runnerId, entryId: this.id, source: 'resource', fact: projectResource(fact) });
        },
      },
      business: {
        receive: (fact: Parameters<typeof projectBusiness>[0]): undefined => {
          if (this.subscriptions.active) this.subscriptions.publish({ runnerId: this.runnerId, entryId: this.id, source: 'business', fact: projectBusiness(fact) });
        },
      },
      checkpoint: {
        receive: (fact: Parameters<typeof projectCheckpoint>[0]): undefined => {
          if (this.subscriptions.active) this.subscriptions.publish({ runnerId: this.runnerId, entryId: this.id, source: 'checkpoint', fact: projectCheckpoint(fact, signal) });
        },
      },
    });
  }

  private publishEntry(change: EntryUpdate): undefined {
    const sequence = ++this.#sequence;
    if (!this.subscriptions.active) return;
    const time = { sequence, occurredAt: this.clock.now() };
    let fact: RunnerEntryFact;
    if (change.kind === 'requested') fact = Object.freeze({ ...time, ...change });
    else if (change.kind === 'attached') fact = Object.freeze({ ...time, kind: 'attached', identity: Object.freeze({ ...change.identity }) });
    else if (change.kind === 'settled') fact = Object.freeze({ ...time, kind: 'settled', status: change.status, ...(change.status !== 'succeeded' ? { diagnostic: projectDiagnostic(change.error) } : {}) });
    else if (change.kind === 'entry-failed') fact = Object.freeze({ ...time, kind: 'entry-failed', diagnostic: projectDiagnostic(change.error) });
    else if (change.kind === 'rejected') fact = Object.freeze({ ...time, kind: 'rejected', reason: change.reason, diagnostic: projectDiagnostic(change.error) });
    else fact = Object.freeze({ ...time, kind: change.kind });
    this.subscriptions.publish({ runnerId: this.runnerId, entryId: this.id, source: 'entry', fact });
  }
}
