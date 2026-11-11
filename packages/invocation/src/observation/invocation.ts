import type { ResourceFact } from '@weiliang0121/capix-resources';
import type { InvocationFact, ResourceObservation, BusinessObservation } from './facts.js';
import type { EventConsumer } from '@weiliang0121/capix-changes';
import type { InvocationObserver } from './observer.js';
import { type ObserverSession, publishSessions } from './session.js';

/** Per-call consumer lifetime and publication; declaration resources are connected by binding. */
export class InvocationObservation {
  readonly #sessions: readonly ObserverSession[];
  /** Opaque installation identities; selection and configuration remain with the host binding. */
  readonly #installed: ReadonlyMap<object, ObserverSession>;

  constructor(sessions: readonly ObserverSession[], installed: ReadonlyMap<object, ObserverSession>) {
    this.#sessions = Object.freeze([...sessions]);
    this.#installed = new Map(installed);
  }

  /** A child binding inherits only the parent's matching installed consumer. */
  observerFor(installation: object): InvocationObserver | undefined {
    const session = this.#installed.get(installation);
    return session?.available() ? session.observer : undefined;
  }

  /** Inheritance follows this installation's session, including children already constructed. */
  sessionFor(installation: object): ObserverSession | undefined {
    return this.#installed.get(installation);
  }

  publish(fact: InvocationFact): unknown | undefined {
    return this.dispatch((observer) => observer.observe(fact));
  }
  readonly resource: EventConsumer<ResourceObservation> = { publish: (event) => this.dispatch((observer) => observer.resource?.(event)) };
  readonly business: EventConsumer<BusinessObservation> = { publish: (event) => this.dispatch((observer) => observer.business?.(event)) };
  readonly facts: EventConsumer<ResourceFact> = { publish: (fact) => this.dispatch((observer) => observer.fact?.(fact)) };
  private dispatch(work: (observer: InvocationObserver) => unknown): unknown | undefined {
    return publishSessions(this.#sessions, work);
  }
}
