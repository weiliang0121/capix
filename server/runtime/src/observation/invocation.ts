import type { TranscriptEvent, MemoryEvent } from '@capix/protocol';
import type { InvocationFact, ResourceObservation, BusinessObservation } from './facts.js';
import type { EventConsumer, InvocationObserver } from './observer.js';
import type { ObservationInstallation } from '../binding/observation.js';
import { type ObserverSession, publishSessions } from './session.js';

/** Per-call consumer lifetime and publication; declaration resources are connected by binding. */
export class InvocationObservation {
  readonly #sessions: readonly ObserverSession[];
  readonly #installed: ReadonlyMap<ObservationInstallation, ObserverSession>;

  constructor(sessions: readonly ObserverSession[], installed: ReadonlyMap<ObservationInstallation, ObserverSession>) {
    this.#sessions = Object.freeze([...sessions]);
    this.#installed = new Map(installed);
  }

  /** A child binding inherits only the parent's matching installed consumer. */
  observerFor(installation: ObservationInstallation): InvocationObserver | undefined {
    const session = this.#installed.get(installation);
    return session?.active ? session.observer : undefined;
  }

  publish(fact: InvocationFact): unknown | undefined {
    return this.dispatch((observer) => observer.observe(fact));
  }
  readonly resource: EventConsumer<ResourceObservation> = { publish: (event) => this.dispatch((observer) => observer.resource?.(event)) };
  readonly business: EventConsumer<BusinessObservation> = { publish: (event) => this.dispatch((observer) => observer.business?.(event)) };
  readonly transcript: EventConsumer<TranscriptEvent> = { publish: (event) => this.dispatch((observer) => observer.transcript?.(event)) };
  readonly memory: EventConsumer<MemoryEvent> = { publish: (event) => this.dispatch((observer) => observer.memory?.(event)) };
  private dispatch(work: (observer: InvocationObserver) => unknown): unknown | undefined {
    return publishSessions(this.#sessions, work);
  }
}
