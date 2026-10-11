import type { InvocationRelationChange, InvocationRelationIdentity } from '../observation/facts.js';
import type { InvocationFailure } from './failure.js';
import type { InvocationView } from './view.js';
import type { InvocationContext } from '../context/context.js';
import { InvocationRelation, type InvocationRelationOptions, type InvocationTarget } from './relation.js';
import type { InvocationProgress } from './progress.js';

export interface ParentInvocation {
  readonly context: InvocationContext;
  readonly children: InvocationChildren;
  readonly hasProgress?: boolean;
  requireHealthy?(): void;
  publishProgress?(fact: InvocationProgress): void;
}

/** Direct child relationships owned by one parent, independent of records and E/O/A. */
export class InvocationChildren {
  readonly #items = new Map<InvocationTarget, InvocationRelation>();

  readonly view: InvocationView['children'];
  constructor(
    private readonly context: InvocationContext,
    private readonly failed?: (failure: InvocationFailure) => void,
    private readonly validate?: () => void,
    private readonly observe?: (identity: InvocationRelationIdentity, change: InvocationRelationChange) => unknown | undefined,
  ) {
    this.view = Object.freeze({
      get: (invocation: InvocationView) => {
        const relation = this.values().find((item) => item.invocation.view === invocation || ('callView' in item.invocation && item.invocation.callView === invocation));
        if (!relation) {
          const error = new Error('Invocation is not a direct child');
          this.reject(error);
          throw error;
        }
        return relation.view;
      },
      values: () => Object.freeze(this.values().map((relation) => relation.view)),
    });
  }

  requireHealthy(): void {
    this.validate?.();
  }

  reject(error: unknown): void {
    this.failed?.(Object.freeze({ kind: 'error', phase: this.context.progress.phase, contextId: this.context.id, error }));
  }

  attach(invocation: InvocationTarget, options: InvocationRelationOptions = {}): InvocationRelation {
    this.context.requireRunning();
    this.requireHealthy();
    if (this.#items.has(invocation)) throw new Error('Child invocation is already attached');
    const identity = Object.freeze({ parentContextId: this.context.id, childContextId: invocation.context.id, parentRound: this.context.progress.round, ...(options.key ? { key: options.key } : {}) });
    const relation = new InvocationRelation(
      invocation,
      this.context.progress.round,
      options.key,
      this.failed,
      (change) => this.observe?.(identity, change),
      () => this.requireHealthy(),
    );
    this.#items.set(invocation, relation);
    this.observe?.(identity, { kind: 'attached' });
    this.requireHealthy();
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
