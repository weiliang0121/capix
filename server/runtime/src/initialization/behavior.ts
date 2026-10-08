import { Initializer } from './initializer.js';
import { checkResourceRequests, resourceRequests, type ResourceRequirements } from '../resource/bindings.js';
import type { InvocationTarget } from '../invocation/relation.js';

interface Behavior {
  readonly requires: ResourceRequirements;
  create(...args: never[]): InvocationTarget<unknown>;
}

/** A declared composition member, independent of whether its reusable behavior has been built. */
export class BehaviorInitializer<B extends Behavior> {
  readonly requires: ResourceRequirements;
  readonly create: B['create'];
  readonly #instance: Initializer<B>;

  constructor(requires: ResourceRequirements, create: () => B) {
    this.requires = Object.freeze({ ...requires });
    this.#instance = new Initializer(() => {
      const behavior = create();
      checkResourceRequests(this.requires, resourceRequests(behavior.requires));
      return behavior;
    });
    // Preserve the concrete parent's and IO's signature while delegating only on actual invocation.
    this.create = ((...args: never[]) => this.get().create(...args)) as B['create'];
    Object.freeze(this);
  }

  get initialized(): boolean {
    return this.#instance.initialized;
  }

  get(): B {
    return this.#instance.get();
  }
}
