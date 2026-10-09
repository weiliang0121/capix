import type { ResourceBindings, ResourceRequirements } from '../resource/bindings.js';

export interface ObservationDefinition<F, P extends object> {
  readonly requires: ResourceRequirements<P>;
  observe(fact: F, ports: Readonly<P>): undefined;
}

/** Erases only the resource parameter after checking the declaration's typed pairing. */
export interface ObservationDeclaration<F> {
  readonly requires: ResourceRequirements;
  bind(resources: ResourceBindings): (fact: F) => undefined;
  readonly failure?: 'isolate' | 'propagate';
}

export function defineObservation<F, P extends object>(definition: ObservationDefinition<F, P>, options: { failure?: 'isolate' | 'propagate' } = {}): ObservationDeclaration<F> {
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
      return (fact: F): undefined => {
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
