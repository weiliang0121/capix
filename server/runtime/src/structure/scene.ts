import { Callable } from './callable.js';
import { appendMembers } from './members.js';
import type { SceneDefinition } from '../definition/scene.js';
import type { Composite } from '../definition/composition.js';
import type { ChildCallable } from '../definition/children.js';
import type { EmptyResources } from '../definition/callable.js';
import { assertStructureConfigurable } from './configuration.js';

/** Resources parameters check constructor configuration only; setters infer each replacement phase. */
export class Scene<Input = unknown, Output = unknown, Resources extends object = EmptyResources, ExceptionResources extends object = EmptyResources, Delta = never> extends Callable<Input, Output, 'scene', Delta> implements Composite {
  #members: readonly ChildCallable[] = Object.freeze([]);

  get members(): readonly ChildCallable[] {
    return this.#members;
  }

  constructor(definition?: SceneDefinition<Input, Output, Resources, ExceptionResources, Delta>) {
    super('scene');
    if (definition !== undefined) this.configure(definition);
  }

  add(...members: readonly ChildCallable[]): this {
    assertStructureConfigurable(this);
    this.#members = appendMembers(this, this.#members, members);
    return this;
  }
}
