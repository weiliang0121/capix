import { isUndefined } from 'es-toolkit/predicate';
import type { TranscriptEvent, MemoryEvent } from '@capix-observer/protocol';
import { resourceRequests, type ResourceRequirements, type ResourceBindings } from '../resource/bindings.js';
import type { ObservationDeclaration } from './definition.js';
import type { CallFact, CallIdentity, CallDescription, ResourceObservation, RuntimeFact } from './facts.js';
import { ObservationError, combineFaults } from './error.js';

export interface EventConsumer<E> {
  publish(event: E): unknown | undefined;
}

/** A concrete installed capability may handle several typed sources without defining a carrier base. */
export interface CallObserver {
  readonly resources?: ResourceBindings;
  observe(fact: CallFact): void;
  resource?(fact: ResourceObservation): void;
  transcript?(event: TranscriptEvent): void;
  memory?(event: MemoryEvent): void;
  available?(): boolean;
}

export interface CallObservationSetup {
  readonly identity: CallIdentity;
  readonly description?: CallDescription;
  readonly declarations?: readonly ObservationDeclaration<CallFact>[];
  readonly resources: ResourceBindings;
}

export interface RuntimeObserver {
  observe(fact: RuntimeFact): undefined;
  available?(): boolean;
}

/** Static scope shape for capability-specific configuration checks; never a live invocation. */
export interface ObservationDeclarationScope {
  readonly level: CallIdentity['level'];
  readonly observation?: readonly ObservationDeclaration<CallFact>[];
}

export interface ObservationInstallation {
  check?(definition: ObservationDeclarationScope, parent?: ObservationDeclarationScope): void;
  readonly failure?: 'isolate' | 'propagate';
  readonly provides?: ResourceRequirements;
  bindRuntime?(identity: Readonly<{ runtimeId: string }>): RuntimeObserver;
  bindCall(setup: CallObservationSetup, parent?: CallObserver): CallObserver;
  invalidate?(error: unknown): void;
}

class ObserverSession<T extends { available?(): boolean } = CallObserver> {
  active = true;
  constructor(
    readonly observer: T,
    readonly failure: 'isolate' | 'propagate',
    private readonly invalidated?: (error: unknown) => void,
  ) {}
  stop(error: unknown): void {
    this.active = false;
    this.invalidated?.(error);
  }
  publish(work: (observer: T) => unknown): unknown | undefined {
    if (!this.active) return undefined;
    try {
      if (this.observer.available?.() === false) {
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

/** Local binding state; no record lookup and no business work ports. */
export class BoundCallObservation {
  readonly #sessions: ObserverSession[] = [];
  readonly #installed = new Map<ObservationInstallation, ObserverSession>();
  constructor(setup: CallObservationSetup, installations: readonly ObservationInstallation[] | undefined, parent?: BoundCallObservation) {
    if (!installations) return;
    for (const installation of installations) {
      const previous = parent ? parent.#installed.get(installation) : undefined;
      if (parent && (!previous || !previous.active || previous.observer.available?.() === false)) continue;
      const observer = installation.bindCall(setup, previous?.observer);
      const session = new ObserverSession(observer, installation.failure ?? 'isolate', (error) => installation.invalidate?.(error));
      this.#installed.set(installation, session);
      this.#sessions.push(session);
    }
    const suppliers = [...this.#installed.values()];
    const resources = setup.resources.supplement(suppliers.flatMap((session) => (session.observer.resources ? [session.observer.resources] : [])));
    for (const declaration of setup.declarations ?? []) {
      const requests = resourceRequests(declaration.requires);
      const unavailable = requests.some((request) => !resources.provides(request));
      if (unavailable) {
        // A disabled parent installation disables its descendant carrier only.
        const inherited = requests.every((request) => resources.provides(request) || installations.some((installation) => resourceRequests(installation.provides ?? {}).some((provided) => provided.offer === request.offer)));
        if (inherited) continue;
      }
      const dependencies = suppliers.filter((session) => requests.some((request) => session.observer.resources?.provides(request)));
      const observe = declaration.bind(resources);
      const available = () => dependencies.every((session) => session.active && session.observer.available?.() !== false);
      const failure = declaration.failure ?? (dependencies.some((session) => session.failure === 'propagate') ? 'propagate' : 'isolate');
      this.#sessions.push(
        new ObserverSession({ observe, available }, failure, (error) => {
          for (const dependency of dependencies) dependency.stop(error);
        }),
      );
    }
  }
  publish(fact: CallFact): unknown | undefined {
    return this.dispatch((observer) => observer.observe(fact));
  }
  readonly resource: EventConsumer<ResourceObservation> = { publish: (event) => this.dispatch((observer) => observer.resource?.(event)) };
  readonly transcript: EventConsumer<TranscriptEvent> = { publish: (event) => this.dispatch((observer) => observer.transcript?.(event)) };
  readonly memory: EventConsumer<MemoryEvent> = { publish: (event) => this.dispatch((observer) => observer.memory?.(event)) };
  private dispatch(work: (observer: CallObserver) => unknown): unknown | undefined {
    const faults: unknown[] = [];
    for (const session of this.#sessions) {
      const fault = session.publish(work);
      if (!isUndefined(fault)) faults.push(fault);
    }
    return combineFaults(faults);
  }
}

export function bindCallObservation(setup: CallObservationSetup, installations: readonly ObservationInstallation[] | undefined, parent?: BoundCallObservation): BoundCallObservation {
  return new BoundCallObservation(setup, installations, parent);
}

/** Long-lived structure observations do not borrow a call context or record identity. */
export function bindRuntimeObservation(runtimeId: string, installations: readonly ObservationInstallation[] = []): EventConsumer<RuntimeFact> {
  const sessions = installations.flatMap((installation) => {
    const observer = installation.bindRuntime?.(Object.freeze({ runtimeId }));
    return observer ? [new ObserverSession(observer, installation.failure ?? 'isolate', (error) => installation.invalidate?.(error))] : [];
  });
  return {
    publish(fact) {
      const faults: unknown[] = [];
      for (const session of sessions) {
        const fault = session.publish((observer) => observer.observe(fact));
        if (!isUndefined(fault)) faults.push(fault);
      }
      return combineFaults(faults);
    },
  };
}
