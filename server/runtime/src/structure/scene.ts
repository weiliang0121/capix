import { Callable } from './callable.js';
import { appendMembers, appendNamedMembers, requireChildCallable } from './members.js';
import type { SceneDefinition } from '../definition/scene.js';
import type { Composite, NamedMembers, MemberRegistration, NamedMemberRegistration } from '../definition/composition.js';
import type { ChildCallable } from '../definition/children.js';
import type { EmptyResources } from '../definition/callable.js';
import { assertStructureConfigurable } from './configuration.js';

/** A callable root with ordinary configuration and explicit member composition. */
export class Scene<Input = unknown, Output = unknown, Resources extends object = EmptyResources, Delta = never> extends Callable<Input, Output, 'scene', Resources, Delta> implements Composite {
  #members: readonly ChildCallable[] = Object.freeze([]);
  #names: NamedMembers = Object.freeze({});

  get names(): NamedMembers {
    return this.#names;
  }

  get members(): readonly ChildCallable[] {
    return this.#members;
  }

  constructor(definition?: SceneDefinition<Input, Output, Resources, Delta>) {
    super('scene', definition);
  }

  add<const Names extends NamedMembers>(members: MemberRegistration<Names>): this & NamedMemberRegistration<Names>;
  add(...members: readonly ChildCallable[]): this;
  add(...members: readonly unknown[]): this {
    assertStructureConfigurable(this);
    if (members.length === 1 && !(members[0] instanceof Callable)) {
      const next = appendNamedMembers(this, this.#members, this.#names, members[0]!);
      this.#members = next.members;
      this.#names = next.names;
    } else {
      const additions: ChildCallable[] = [];
      for (const member of members) {
        requireChildCallable(member);
        additions.push(member);
      }
      this.#members = appendMembers(this, this.#members, additions);
    }
    return this;
  }
}
