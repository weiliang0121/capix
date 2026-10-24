import type { CallableKind } from '@capix/protocol';
import type { ResourceRequirements } from '../resource/bindings.js';
import type { InvocationFact } from '../observation/facts.js';

export interface ObservationDefinition<Fact, Ports extends object> {
  readonly deps: ResourceRequirements<Ports>;
  observe(fact: Fact, ports: Readonly<Ports>): undefined;
}

/** Preserves the fact contract while erasing only the checked resource pairing for composition. */
export interface ObservationDeclaration<Fact> {
  readonly deps: ResourceRequirements;
  readonly observe: (fact: Fact, ports: Readonly<object>) => undefined;
  readonly failure?: 'isolate' | 'propagate';
}

/** Static declaration shape for capability-specific checks; never a live invocation. */
export interface ObservationDeclarationScope {
  readonly kind: CallableKind;
  readonly observation?: readonly ObservationDeclaration<InvocationFact>[];
}

/** Declare consumption without selecting, realizing or activating any resource. */
export function defineObservation<Fact, Ports extends object>(definition: ObservationDefinition<Fact, Ports>, options: { failure?: 'isolate' | 'propagate' } = {}): ObservationDeclaration<Fact> {
  return Object.freeze({
    deps: Object.freeze({ ...definition.deps }),
    failure: options.failure,
    observe: (fact: Fact, ports: Readonly<object>) => definition.observe(fact, ports as Readonly<Ports>),
  });
}
