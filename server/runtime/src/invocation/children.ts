import { AsyncLocalStorage } from 'node:async_hooks';
import type { InvocationRelationChange, InvocationRelationIdentity } from '../observation/facts.js';
import type { InvocationFailure } from './failure.js';
import type { InvocationView } from './view.js';
import type { InvocationContext } from '../context/context.js';
import { InvocationRelation, type InvocationRelationOptions, type InvocationTarget } from './relation.js';
import type { InvocationProgress } from './progress.js';
import type { CheckpointChild, InvocationCheckpointFrame } from '../checkpoint/contract.js';
import { cloneCheckpointValue } from '../checkpoint/value.js';
import { checkpointTarget } from '../checkpoint/target.js';
import { RuntimeErrorHelper } from '../errors/helper.js';

export interface ParentInvocation {
  readonly context: InvocationContext;
  readonly children: InvocationChildren;
  readonly hasProgress?: boolean;
  readonly recovering?: boolean;
  requireHealthy?(): void;
  publishProgress?(fact: InvocationProgress): void;
}

/** Direct relationships, their order and saved continuation facts belong to this parent. */
export class InvocationChildren {
  readonly #items = new Map<string, InvocationRelation>();
  readonly #saved = new Map<string, CheckpointChild>();
  #nextOrder = 0;
  #receptions?: AsyncLocalStorage<{ childContextId: string; active: boolean }>;
  readonly view: InvocationView['children'];
  constructor(
    private readonly context: InvocationContext,
    private readonly failed?: (failure: InvocationFailure) => void,
    private readonly validate?: () => void,
    private readonly observe?: (identity: InvocationRelationIdentity, change: InvocationRelationChange) => unknown | undefined,
    private readonly signal: AbortSignal = new AbortController().signal,
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
  private relation<Output>(target: InvocationTarget<Output>, round: number, order: number, key?: string): InvocationRelation<Output> {
    const identity = Object.freeze({ parentContextId: this.context.id, childContextId: target.context.id, parentRound: round, ...(key ? { key } : {}) });
    return new InvocationRelation(
      target,
      round,
      key,
      this.failed,
      (change) => this.observe?.(identity, change),
      () => this.requireHealthy(),
      order,
      (work) => this.receive(target.context.id, work),
    );
  }
  private async receive<Value>(childContextId: string, work: () => Promise<Value>): Promise<Value> {
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
    this.observe?.({ parentContextId: this.context.id, childContextId: target.context.id, parentRound: relation.round, ...(relation.key ? { key: relation.key } : {}) }, { kind: 'attached' });
    this.requireHealthy();
    return relation;
  }
  adopt<Output>(target: InvocationTarget<Output>): InvocationRelation<Output> {
    this.requireHealthy();
    const relation = this.#items.get(target.context.id);
    const saved = this.#saved.get(target.context.id);
    if (!relation || !saved || saved.state.kind !== 'waiting' || relation.invocation.context.status !== 'running') throw new Error('Restored child is not the saved waiting child');
    relation.replace(target);
    this.#saved.delete(target.context.id);
    return relation as InvocationRelation<Output>;
  }
  get<Output>(target: InvocationTarget<Output>): InvocationRelation<Output> {
    const relation = this.#items.get(target.context.id);
    if (!relation || relation.invocation !== target) throw new Error('Invocation is not a direct child');
    return relation as InvocationRelation<Output>;
  }
  saved(id: string): CheckpointChild | undefined {
    return this.#saved.get(id);
  }
  resolved(id: string): InvocationTarget | undefined {
    return this.#items.get(id)?.invocation;
  }
  replaceSaved(child: CheckpointChild, target: InvocationTarget): void {
    const relation = this.#items.get(child.identity.contextId);
    if (!relation || !this.#saved.has(child.identity.contextId)) throw new Error('No saved child relation');
    // Decode exactly once in the target so parent evidence and returned value have one identity.
    relation.install(target, child.state, () => (target.context.state.status === 'succeeded' ? target.context.state.output : undefined));
    this.#saved.set(child.identity.contextId, child);
  }
  restore(frame: InvocationCheckpointFrame): void {
    if (this.#items.size || this.#nextOrder) throw new Error('Child baseline already installed');
    this.#nextOrder = frame.nextChildOrder;
    for (const child of frame.children) {
      const target = checkpointTarget(child, undefined, this.signal);
      const relation = this.relation(target, child.round, child.order, child.key);
      relation.install(target, child.state, (output) => output);
      this.#items.set(child.identity.contextId, relation);
      this.#saved.set(child.identity.contextId, child);
    }
  }
  capture(): Pick<InvocationCheckpointFrame, 'nextChildOrder' | 'children'> {
    const children = this.values().map((relation): CheckpointChild => {
      const target = relation.invocation;
      const binding = target.checkpointBinding;
      const saved = this.#saved.get(target.context.id);
      const identity = target.identity ?? { contextId: target.context.id, parentContextId: this.context.id, level: ('level' in target.context ? target.context.level : 'attempt') as 'attempt' };
      const base = { identity, ...(binding ? { contract: { key: binding.key, version: binding.version } } : saved?.contract ? { contract: saved.contract } : {}), round: relation.round, order: relation.order, ...(relation.key ? { key: relation.key } : {}), input: binding ? cloneCheckpointValue(binding.input.encode(target.context.input)) : saved ? saved.input : cloneCheckpointValue(target.context.input) };
      if (!relation.returned) {
        if (!base.contract) throw new Error('Waiting child has no checkpoint declaration');
        return { ...base, state: { kind: 'waiting' } };
      }
      if (relation.returned.status === 'failed') {
        const failure = relation.returned.failure;
        if (relation.round >= this.context.progress.round || failure?.kind !== 'exception' || !failure.contract || failure.contextId !== target.context.id) throw new Error('Only a prior round declared child exception can be checkpointed as history');
        if (saved?.state.kind === 'failed') return { ...base, state: saved.state };
        return { ...base, state: { kind: 'failed', error: cloneCheckpointValue(RuntimeErrorHelper.format(relation.returned.error)), failure: { kind: 'exception', phase: failure.phase, contextId: failure.contextId, contract: failure.contract }, progress: { round: target.context.progress.round, phase: target.context.progress.phase, currentInput: binding ? cloneCheckpointValue(binding.input.encode(target.context.currentInput)) : cloneCheckpointValue(target.context.currentInput) } } };
      }
      if (relation.reception.status === 'failed') throw new Error('Failed child reception cannot be checkpointed');
      const output = binding ? cloneCheckpointValue(binding.output.encode(relation.returned.output)) : cloneCheckpointValue(relation.returned.output);
      return { ...base, state: { kind: 'returned', output, progress: { round: target.context.progress.round, phase: target.context.progress.phase, currentInput: binding ? cloneCheckpointValue(binding.input.encode(target.context.currentInput)) : cloneCheckpointValue(target.context.currentInput) }, reception: relation.reception.status === 'accepted' ? { kind: 'accepted', ...(relation.reception.output !== undefined ? { output: cloneCheckpointValue(relation.reception.output) } : {}) } : { kind: relation.reception.status } } };
    });
    return { nextChildOrder: this.#nextOrder, children };
  }
  values(): readonly InvocationRelation[] {
    return Object.freeze([...this.#items.values()]);
  }
}
