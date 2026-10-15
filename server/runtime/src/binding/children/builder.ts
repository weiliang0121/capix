import type { ChildDefinition } from '../../definition/children.js';
import type { InvocationTarget } from '../../invocation/relation.js';
import type { InvocationView } from '../../invocation/view.js';
import type { BoundChildren } from './bound.js';
import { InvocationChildBindings, type ChildBindingsParent } from './binding.js';
import type { ChildBindings } from './contract.js';

export interface ChildBindingsBuildOptions {
  readonly view: InvocationView;
  readonly uses?: readonly ChildDefinition[];
  readonly validate?: () => void;
  /** One registry per parent invocation, shared by all of its phase bindings. */
  readonly calls: Map<InvocationView, InvocationTarget>;
}

/** Resolve the allowed structures and wire one invocation phase without initializing children. */
export class ChildBindingsBuilder {
  constructor(private readonly children: BoundChildren) {}

  build(parent: ChildBindingsParent, options: ChildBindingsBuildOptions): ChildBindings {
    try {
      const definitions = options.uses ?? this.children.definitions();
      this.children.checkUses(definitions);
      const allowed = new Set(definitions);
      return new InvocationChildBindings({ children: this.children, parent, view: options.view, allowed, validate: options.validate, calls: options.calls });
    } catch (error) {
      parent.reject(error);
      throw error;
    }
  }
}
