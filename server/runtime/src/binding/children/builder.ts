import type { ChildCalls, ChildContract, ResumeChildCalls } from '../../definition/children.js';
import type { BoundChildren } from './bound.js';
import { InvocationChildBindings, type ChildBindingsParent } from './binding.js';
import { InvocationChildReferences } from './references.js';
import { BoundReceptions } from '../receptions.js';

export interface ChildBindingsBuildOptions {
  readonly uses?: readonly ChildContract[];
  readonly validate: () => void;
  readonly references: InvocationChildReferences;
  readonly restoring?: boolean;
}

/** Resolve phase authority without initializing the reusable child structures. */
export class ChildBindingsBuilder {
  constructor(
    readonly children: BoundChildren,
    readonly receptions = new BoundReceptions([], children),
  ) {}

  references(parent: ChildBindingsParent): InvocationChildReferences {
    return new InvocationChildReferences(parent, this.children, this.receptions);
  }

  build(parent: ChildBindingsParent, options: ChildBindingsBuildOptions): ChildCalls | ResumeChildCalls {
    try {
      const definitions = options.uses ?? this.children.definitions();
      this.children.checkUses(definitions);
      return new InvocationChildBindings({ children: this.children, names: this.children.names(), receptions: this.receptions, parent, allowed: new Set(definitions), validate: options.validate, references: options.references, restoring: options.restoring ?? false }).port;
    } catch (error) {
      parent.reject(error);
      throw error;
    }
  }
}
