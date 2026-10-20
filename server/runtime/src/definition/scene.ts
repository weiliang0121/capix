import { CallableDefinition } from './callable.js';
import type { Composite } from './composition.js';
import type { ChildDefinition } from './children.js';

/** Reusable scene definition; call state is owned by Invocation. */
export abstract class SceneDefinition<Input, Output, Resources extends object = Record<string, never>, ExceptionResources extends object = Record<string, never>, Delta = never> extends CallableDefinition<Input, Output, 'scene', Resources, ExceptionResources, Delta> implements Composite {
  readonly kind = 'scene' as const;
  readonly members: readonly ChildDefinition[] = [];
}
