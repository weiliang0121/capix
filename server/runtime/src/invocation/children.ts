import { AsyncLocalStorage } from 'node:async_hooks';
import type { InvocationRelationChange, InvocationRelationIdentity } from '../observation/facts.js';
import type { InvocationFailure } from './failure.js';
import type { InvocationView } from './view.js';
import type { InvocationContext } from '../context/context.js';
import { InvocationRelation, type InvocationRelationOptions, type InvocationTarget, type InvocationRelationBaseline, type InvocationRelationOwner, type InvocationRelationSetup } from './relation.js';
import type { InvocationProgress } from './progress.js';

export interface ParentInvocation {
  readonly context: InvocationContext;
  readonly children: InvocationChildren;
  readonly hasProgress?: boolean;
  readonly recovering?: boolean;
  requireHealthy?(): void;
  publishProgress?(fact: InvocationProgress): void;
}

/** A decoded baseline for one direct relationship, without checkpoint storage or codecs. */
export interface InvocationChildBaseline extends InvocationRelationSetup {
  readonly state: InvocationRelationBaseline;
}

/** Direct relationships, their order and active acceptance windows belong to this parent. */
export class InvocationChildren implements InvocationRelationOwner {
  readonly #items = new Map<string, InvocationRelation>();
  readonly #installed = new Set<string>();
  #nextOrder = 0;
  #receptions?: AsyncLocalStorage<{ childContextId: string; active: boolean }>;
  readonly view: InvocationView['children'];
  constructor(
    private readonly context: InvocationContext,
    private readonly failed?: (failure: InvocationFailure) => void,
    private readonly validate?: () => void,
    private readonly observe?: (identity: InvocationRelationIdentity, change: InvocationRelationChange) => unknown | undefined,
  ) {
    this.view = Object.freeze({
      get: (invocation: InvocationView) => {
        const relation = this.values().find((item) => item.invocation.view === invocation || item.invocation.callView === invocation);
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
  get reception(): Readonly<{ parentContextId: string; childContextId: string }> {
    this.requireHealthy();
    const reception = this.#receptions?.getStore();
    if (!reception?.active) throw new Error('Fixed entity operations require an active direct-child reception');
    return Object.freeze({ parentContextId: this.context.id, childContextId: reception.childContextId });
  }
  requireHealthy(): void {
    this.validate?.();
  }
  reject(error: unknown): void {
    this.failed?.(Object.freeze({ kind: 'error', phase: this.context.progress.phase, contextId: this.context.id, error }));
  }
  fail(failure: InvocationFailure): void {
    this.failed?.(failure);
  }
  publish(relation: InvocationRelation, change: InvocationRelationChange): unknown | undefined {
    const identity = Object.freeze({ parentContextId: this.context.id, childContextId: relation.invocation.context.id, parentRound: relation.round, ...(relation.key ? { key: relation.key } : {}) });
    return this.observe?.(identity, change);
  }
  private relation<Output>(target: InvocationTarget<Output>, round: number, order: number, key?: string): InvocationRelation<Output> {
    return new InvocationRelation({ target, round, order, key }, this);
  }
  async receive<Value>(relation: InvocationRelation, work: () => Promise<Value>): Promise<Value> {
    const childContextId = relation.invocation.context.id;
    this.#receptions ??= new AsyncLocalStorage();
    const reception = { childContextId, active: true };
    try {
      return await this.#receptions.run(reception, work);
    } finally {
      reception.active = false;
    }
  }
  attach<Output>(target: InvocationTarget<Output>, options: InvocationRelationOptions = {}): InvocationRelation<Output> {
    this.context.requireRunning();
    this.requireHealthy();
    if (this.#items.has(target.context.id)) throw new Error('Child invocation is already attached');
    const relation = this.relation(target, this.context.progress.round, this.#nextOrder++, options.key);
    this.#items.set(target.context.id, relation);
    this.publish(relation, { kind: 'attached' });
    this.requireHealthy();
    return relation;
  }
  adopt<Output>(target: InvocationTarget<Output>): InvocationRelation<Output> {
    this.requireHealthy();
    const relation = this.#items.get(target.context.id);
    if (!relation || !this.#installed.has(target.context.id) || relation.returned || relation.invocation.context.status !== 'running') throw new Error('Restored child is not the saved waiting child');
    relation.replace(target);
    this.#installed.delete(target.context.id);
    return relation as InvocationRelation<Output>;
  }
  get<Output>(target: InvocationTarget<Output>): InvocationRelation<Output> {
    const relation = this.#items.get(target.context.id);
    if (!relation || relation.invocation !== target) throw new Error('Invocation is not a direct child');
    return relation as InvocationRelation<Output>;
  }
  get nextOrder(): number {
    return this.#nextOrder;
  }
  replaceSaved(id: string, target: InvocationTarget, state: InvocationRelationBaseline): void {
    const relation = this.#items.get(id);
    if (!relation || !this.#installed.has(id)) throw new Error('No saved child relation');
    if (target.context.id !== id) throw new Error('Restored child identity changed');
    relation.install(target, state);
  }
  install(nextOrder: number, children: readonly InvocationChildBaseline[]): void {
    if (this.#items.size || this.#nextOrder) throw new Error('Child baseline already installed');
    this.#nextOrder = nextOrder;
    for (const child of children) {
      const relation = this.relation(child.target, child.round, child.order, child.key);
      relation.install(child.target, child.state);
      this.#items.set(child.target.context.id, relation);
      this.#installed.add(child.target.context.id);
    }
  }
  values(): readonly InvocationRelation[] {
    return Object.freeze([...this.#items.values()]);
  }
}
