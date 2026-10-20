import { Callable } from './callable.js';
import { appendMembers } from './members.js';
import type { GroupDefinition } from '../definition/group.js';
import type { Composite } from '../definition/composition.js';
import type { ChildCallable } from '../definition/children.js';
import type { EmptyResources } from '../definition/callable.js';

/** A callable composite owns its own processing, independently of its registered members. */
export class Group<Input = unknown, Output = unknown, Resources extends object = EmptyResources, ExceptionResources extends object = EmptyResources, Delta = never> extends Callable<Input, Output, 'group', Delta> implements Composite {
  members: readonly ChildCallable[] = Object.freeze([]);

  constructor(definition?: GroupDefinition<Input, Output, Resources, ExceptionResources, Delta>) {
    super('group');
    if (definition !== undefined) this.configure(definition);
  }

  add(...members: readonly ChildCallable[]): this {
    this.members = appendMembers(this, this.members, members);
    return this;
  }
}
