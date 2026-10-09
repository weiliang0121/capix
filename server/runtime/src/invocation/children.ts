import type { InvocationView } from './view.js';
import type { InvocationContext } from '../context/context.js';
import { InvocationRelation, type InvocationRelationOptions, type InvocationTarget } from './relation.js';

export interface ParentInvocation {
  readonly context: InvocationContext;
  readonly children: InvocationChildren;
}

/** Direct child relationships owned by one parent, independent of records and E/O/A. */
export class InvocationChildren {
  readonly #items = new Map<InvocationTarget, InvocationRelation>();

  readonly view: InvocationView['children'];
  constructor(private readonly context: InvocationContext) {
    this.view = Object.freeze({
      get: (invocation: InvocationView) => {
        const relation = this.values().find((item) => item.invocation.view === invocation || ('callView' in item.invocation && item.invocation.callView === invocation));
        if (!relation) throw new Error('Invocation is not a direct child');
        return relation.view;
      },
      values: () => Object.freeze(this.values().map((relation) => relation.view)),
    });
  }

  attach(invocation: InvocationTarget, options: InvocationRelationOptions = {}): InvocationRelation {
    this.context.requireRunning();
    if (this.#items.has(invocation)) throw new Error('Child invocation is already attached');
    const relation = new InvocationRelation(invocation, this.context.progress.round, options.key);
    this.#items.set(invocation, relation);
    return relation;
  }

  get(invocation: InvocationTarget): InvocationRelation {
    const relation = this.#items.get(invocation);
    if (!relation) throw new Error('Invocation is not a direct child');
    return relation;
  }

  values(): readonly InvocationRelation[] {
    return Object.freeze([...this.#items.values()]);
  }
}
