import type { Stable } from '@weiliang0121/capix-contracts';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { InvocationRelationChange, InvocationRelationIdentity } from '../observation/facts.js';
import type { InvocationFailure } from './failure.js';
import type { InvocationView } from './view.js';
import type { InvocationContext } from '../context/context.js';
import { InvocationRelation, type InvocationRelationOptions, type InvocationTarget, type InvocationRelationBaseline, type InvocationRelationOwner, type InvocationRelationSetup } from './relation.js';
import type { InvocationProgress } from './progress.js';
import { DeclaredException } from '../exception/contract.js';
import { InvocationProvenance, type InvocationPropagationScope, type InvocationExceptionOrigin } from './provenance.js';

interface ReceptionScope {
  readonly owner: symbol;
  readonly childContextId: string;
  readonly parent: ReceptionScope | undefined;
  active: boolean;
}

// One async-context carrier for the mechanism. An ALS per parent would stay
// enabled and add another property to every subsequent async resource.
const receptions = new AsyncLocalStorage<ReceptionScope>();

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
  readonly #receptionOwner = Symbol();
  readonly view: InvocationView['children'];
  readonly #provenance: InvocationProvenance;
  readonly #calls = new Set<Promise<void>>();
  readonly #acceptances = new Set<Promise<void>>();
  #trackingFacts = false;
  #readingFacts = false;
  #factRevision = 0;
  readonly #changedFacts = new Map<string, number>();
  constructor(
    private readonly context: InvocationContext,
    private readonly failed?: (failure: InvocationFailure) => void,
    private readonly validate?: () => void,
    private readonly observe?: (identity: InvocationRelationIdentity, change: InvocationRelationChange) => unknown | undefined,
    private readonly classifyFailure?: (error: unknown, origin: InvocationExceptionOrigin) => InvocationFailure,
  ) {
    this.#provenance = new InvocationProvenance(context);
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
  captureDelivery(): InvocationPropagationScope {
    return this.#provenance.capture();
  }
  resolveDelivery(error: unknown) {
    return this.#provenance.resolve(error);
  }
  private origin(relation: InvocationRelation, kind: 'child-return' | 'child-reception'): InvocationExceptionOrigin {
    return Object.freeze({ kind, child: Object.freeze({ parentContextId: this.context.id, childContextId: relation.invocation.context.id, parentRound: relation.round, order: relation.order }) });
  }
  deliverReturn(relation: InvocationRelation, error: unknown, failure: InvocationFailure, scope: InvocationPropagationScope): unknown {
    return failure.kind === 'exception' && error instanceof DeclaredException ? this.#provenance.deliver(scope, error, this.origin(relation, 'child-return')) : error;
  }
  receptionFailure(relation: InvocationRelation, error: unknown, scope: InvocationPropagationScope): { error: unknown; failure: InvocationFailure; delivery: unknown } {
    let delivered = error;
    try {
      this.#provenance.require(scope, error);
      this.#provenance.resolve(error);
    } catch (invalid) {
      delivered = invalid;
    }
    const origin = this.origin(relation, 'child-reception');
    const failure = this.classifyFailure?.(delivered, origin) ?? Object.freeze({ kind: 'error' as const, contextId: this.context.id, phase: this.context.progress.phase, error: delivered });
    if (failure.kind !== 'exception' || !(failure.error instanceof DeclaredException)) return { error: failure.error, failure, delivery: failure.error };
    const propagated = this.#provenance.resolve(delivered);
    return { error: failure.error, failure, delivery: propagated ? delivered : this.#provenance.deliver(scope, failure.error, origin) };
  }
  get reception(): Readonly<{ parentContextId: string; childContextId: string }> {
    this.requireHealthy();
    let reception = receptions.getStore();
    while (reception && reception.owner !== this.#receptionOwner) reception = reception.parent;
    // Never skip an expired matching scope to borrow an older one's authority.
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
    if (this.#trackingFacts) this.#changedFacts.set(relation.invocation.context.id, ++this.#factRevision);
    const identity = Object.freeze({ parentContextId: this.context.id, childContextId: relation.invocation.context.id, parentRound: relation.round, ...(relation.key ? { key: relation.key } : {}) });
    return this.observe?.(identity, change);
  }
  private relation<Output>(target: InvocationTarget<Output>, round: number, order: number, key?: string, declarationPosition?: number, receiveFailure?: boolean): InvocationRelation<Output> {
    return new InvocationRelation({ target, round, order, key, declarationPosition, receiveFailure }, this);
  }
  run<Value>(target: InvocationTarget<Value>, work: () => Promise<Stable<Value>>): Promise<Stable<Value>> {
    // Start admission is checked inside the child's delivery boundary, so a rejected
    // start still fixes that call's failed Context and returned relationship.
    this.get(target);
    return this.track(this.#calls, work);
  }
  accepting<Value>(work: () => Promise<Value>): Promise<Value> {
    this.requireHealthy();
    return this.track(this.#acceptances, work);
  }
  /** Join real activities, not pending relationships or saved facts. Rejections retain their normal delivery. */
  async settle(): Promise<void> {
    while (this.#calls.size || this.#acceptances.size) await Promise.all([...this.#calls, ...this.#acceptances]);
  }
  settleAcceptances(): Promise<void> | undefined {
    if (!this.#acceptances.size) return;
    return this.drainAcceptances();
  }
  private async drainAcceptances(): Promise<void> {
    while (this.#acceptances.size) await Promise.all(this.#acceptances);
  }
  private track<Value>(activities: Set<Promise<void>>, work: () => Promise<Value>): Promise<Value> {
    let release!: () => void;
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    activities.add(settled);
    const complete = () => {
      activities.delete(settled);
      release();
    };
    try {
      const result = work();
      void result.then(complete, complete);
      return result;
    } catch (error) {
      complete();
      throw error;
    }
  }
  async receive<Value>(relation: InvocationRelation, work: () => Promise<Value>): Promise<Value> {
    const childContextId = relation.invocation.context.id;
    const reception: ReceptionScope = { owner: this.#receptionOwner, childContextId, active: true, parent: receptions.getStore() };
    try {
      return await receptions.run(reception, work);
    } finally {
      reception.active = false;
    }
  }
  attach<Output>(target: InvocationTarget<Output>, options: InvocationRelationOptions = {}): InvocationRelation<Output> {
    this.changing();
    this.context.requireRunning();
    this.requireHealthy();
    if (this.#items.has(target.context.id)) throw new Error('Child invocation is already attached');
    const relation = this.relation(target, this.context.progress.round, this.#nextOrder++, options.key, options.declarationPosition, options.receiveFailure);
    this.#items.set(target.context.id, relation);
    this.publish(relation, { kind: 'attached' });
    this.requireHealthy();
    return relation;
  }
  adopt<Output>(target: InvocationTarget<Output>): InvocationRelation<Output> {
    this.changing();
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
    this.changing();
    const relation = this.#items.get(id);
    if (!relation || !this.#installed.has(id)) throw new Error('No saved child relation');
    if (target.context.id !== id) throw new Error('Restored child identity changed');
    relation.install(target, state);
    if (this.#trackingFacts) this.#changedFacts.set(id, ++this.#factRevision);
  }
  install(nextOrder: number, children: readonly InvocationChildBaseline[]): void {
    this.changing();
    if (this.#items.size || this.#nextOrder) throw new Error('Child baseline already installed');
    this.#nextOrder = nextOrder;
    for (const child of children) {
      const relation = this.relation(child.target, child.round, child.order, child.key, child.declarationPosition);
      relation.install(child.target, child.state);
      this.#items.set(child.target.context.id, relation);
      this.#installed.add(child.target.context.id);
    }
  }
  values(): readonly InvocationRelation[] {
    return Object.freeze([...this.#items.values()]);
  }

  /** Point lookup never grants a child action or changes its lifecycle. */
  byContextId(contextId: string): InvocationRelation | undefined {
    return this.#items.get(contextId);
  }

  /** A checkpoint observes real owner changes, not optional observation events. */
  trackFacts(): void {
    this.#trackingFacts = true;
    for (const id of this.#items.keys()) this.#changedFacts.set(id, ++this.#factRevision);
  }

  get factRevision(): number {
    return this.#factRevision;
  }

  changedFacts(): readonly InvocationRelation[] {
    return [...this.#changedFacts.keys()].map((id) => this.#items.get(id)!);
  }

  acknowledgeFacts(revision: number): void {
    for (const [id, changed] of this.#changedFacts) if (changed <= revision) this.#changedFacts.delete(id);
  }

  /** No lock crosses an await. Author code cannot mutate this owner during a save cut. */
  readFacts<Value>(read: () => Value): Value {
    if (this.#readingFacts) throw new Error('Invocation fact inspection cannot reenter');
    this.#readingFacts = true;
    try {
      return read();
    } finally {
      this.#readingFacts = false;
    }
  }

  changing(): void {
    if (!this.#readingFacts) return;
    const error = new Error('Invocation facts cannot change during checkpoint inspection');
    this.reject(error);
    throw error;
  }
}
