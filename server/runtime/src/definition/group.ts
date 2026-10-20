import { CallableDefinition } from './callable.js';
import type { Composite } from './composition.js';
import type { ChildDefinition } from './children.js';

/** Reusable group definition; call state is owned by Invocation. */
export abstract class GroupDefinition<Input, Output, Resources extends object = Record<string, never>, ExceptionResources extends object = Record<string, never>, Delta = never> extends CallableDefinition<Input, Output, 'group', Resources, ExceptionResources, Delta> implements Composite {
  readonly kind = 'group' as const;
  readonly members: readonly ChildDefinition[] = [];
}
