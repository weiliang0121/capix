import type { ResourceBindings, ResourceRequirements } from '../resource/bindings.js';

export interface ObservationDefinition<Fact, Ports extends object> {
  readonly requires: ResourceRequirements<Ports>;
  observe(fact: Fact, ports: Readonly<Ports>): undefined;
}

/** Erases only the resource parameter after checking the declaration's typed pairing. */
export interface ObservationDeclaration<Fact> {
  readonly requires: ResourceRequirements;
  bind(resources: ResourceBindings): (fact: Fact) => undefined;
  readonly failure?: 'isolate' | 'propagate';
}

export function defineObservation<Fact, Ports extends object>(definition: ObservationDefinition<Fact, Ports>, options: { failure?: 'isolate' | 'propagate' } = {}): ObservationDeclaration<Fact> {
  return Object.freeze({
    requires: Object.freeze({ ...definition.requires }),
    failure: options.failure,
    bind(resources: ResourceBindings) {
      const local = resources.select(definition.requires);
      let active = false;
      let started = false;
      local.restrict(() => {
        if (!active) throw new Error('Observation access window has ended');
      });
      return (fact: Fact): undefined => {
        active = true;
        try {
          if (!started) {
            started = true;
            local.start();
          }
          return definition.observe(fact, local.values);
        } finally {
          active = false;
        }
      };
    },
  });
}
