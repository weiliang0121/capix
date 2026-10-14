import type { CheckpointChild } from '../checkpoint/contract.js';
import type { CheckpointBinding } from '../checkpoint/work.js';
import type { InvocationIdentity } from './identity.js';
import type { ChildInvocationView } from './view.js';
import type { InvocationOutputReceiver } from '../output/contract.js';
import type { InvocationRelationChange } from '../observation/facts.js';
import { combineFaults } from '../observation/error.js';
import type { InvocationFailure } from './failure.js';
import type { InvocationRelationView, InvocationView } from './view.js';
import type { InvocationContext } from '../context/context.js';
import type { InvocationResult } from './result.js';

export interface InvocationRelationOptions {
  /** Work position in a composition, not the reusable behavior's identity. */
  key?: string;
  output?: InvocationOutputReceiver<any, any>;
}

export interface InvocationTarget<Output = unknown> {
  readonly context: InvocationContext<unknown, Output>;
  run(): Promise<Output>;
  readonly view?: InvocationView;
  readonly callView?: ChildInvocationView;
  readonly checkpointBinding?: CheckpointBinding;
  readonly identity?: InvocationIdentity;
}

export type InvocationRelationReception = Readonly<{ status: 'pending' } | { status: 'receiving' } | { status: 'accepted'; output: unknown } | { status: 'failed'; error: unknown }>;

/** A direct parent-child relationship, not another invocation or E/O/A execution layer. */
export class InvocationRelation<Output = unknown> {
  #returned?: InvocationResult<Output>;
  #restoredReception = false;
  readonly view: InvocationRelationView;
  #reception: InvocationRelationReception = Object.freeze({ status: 'pending' });

  constructor(
    private target: InvocationTarget<Output>,
    readonly round: number,
    readonly key?: string,
    private readonly failed?: (failure: InvocationFailure) => void,
    private readonly observe?: (change: InvocationRelationChange) => unknown | undefined,
    private readonly validate?: () => void,
    readonly order = 0,
    private readonly receiving?: <Value>(work: () => Promise<Value>) => Promise<Value>,
  ) {
    const relation = this;
    this.view = Object.freeze({
      get invocation() {
        if (!relation.invocation.view) throw new Error('Child invocation has no business view');
        return relation.invocation.view;
      },
      round,
      key,
      get returned() {
        return relation.returned;
      },
      get reception() {
        return relation.reception;
      },
    });
  }

  get invocation(): InvocationTarget<Output> {
    return this.target;
  }

  /** Rebuild a saved relationship without emitting new return/acceptance facts. */
  install(target: InvocationTarget<Output>, state: CheckpointChild['state'], decode: (value: any) => Output): void {
    this.target = target;
    this.#restoredReception = state.kind === 'returned' && state.reception.kind === 'receiving';
    this.#returned = state.kind === 'returned' ? Object.freeze({ status: 'succeeded', output: decode(state.output) }) : state.kind === 'failed' ? Object.freeze({ status: 'failed', error: state.error, failure: Object.freeze({ ...state.failure, error: state.error }) }) : undefined;
    this.#reception = Object.freeze(state.kind === 'returned' ? (state.reception.kind === 'accepted' ? { status: 'accepted', output: state.reception.output } : { status: state.reception.kind }) : { status: 'pending' });
  }

  replace(target: InvocationTarget<Output>): void {
    this.target = target;
  }

  get returned(): InvocationResult<Output> | undefined {
    return this.#returned;
  }

  get reception(): InvocationRelationReception {
    return this.#reception;
  }

  returnedWith(result: InvocationResult<Output>): void {
    if (this.#returned) throw new Error('Child invocation has already returned');
    this.#returned = Object.freeze(result);
    if (result.status === 'failed' && result.failure) this.failed?.(result.failure);
    this.observe?.({ kind: 'returned', result: this.#returned });
  }

  async accept<Value>(work: (delivered: Output) => Value | Promise<Value>): Promise<Value> {
    this.validate?.();
    if (this.#returned?.status !== 'succeeded') throw new Error('Child invocation has not returned successfully');
    if (this.#reception.status !== 'pending' && !this.#restoredReception) throw new Error('Child result has already entered acceptance');
    this.#restoredReception = false;
    this.#reception = Object.freeze({ status: 'receiving' });
    const observed = this.observe?.({ kind: 'receiving' });
    if (observed !== undefined) {
      this.#reception = Object.freeze({ status: 'failed', error: observed });
      const failed = this.observe?.({ kind: 'failed', error: observed, source: 'observation' });
      throw combineFaults([observed, ...(failed !== undefined ? [failed] : [])]);
    }
    let output: Value;
    try {
      this.validate?.();
      const delivered = this.#returned.output;
      const execute = async () => work(delivered);
      output = await (this.receiving ? this.receiving(execute) : execute());
    } catch (error) {
      this.#reception = Object.freeze({ status: 'failed', error });
      const failed = this.observe?.({ kind: 'failed', error, source: 'work' });
      if (failed !== undefined) throw new AggregateError([error, failed], 'Child acceptance and observation both failed', { cause: error });
      throw error;
    }
    this.#reception = Object.freeze({ status: 'accepted', output });
    const accepted = this.observe?.({ kind: 'accepted', output });
    if (accepted !== undefined) throw accepted;
    return output;
  }
}
