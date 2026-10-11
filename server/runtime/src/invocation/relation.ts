import type { InvocationRelationChange } from '../observation/facts.js';
import { combineFaults } from '../observation/error.js';
import type { InvocationFailure } from './failure.js';
import type { InvocationRelationView, InvocationView } from './view.js';
import type { InvocationContext } from '../context/context.js';
import type { InvocationResult } from './result.js';

export interface InvocationRelationOptions {
  /** Work position in a composition, not the reusable behavior's identity. */
  key?: string;
}

export interface InvocationTarget<Output = unknown> {
  readonly context: InvocationContext<unknown, Output>;
  run(): Promise<Output>;
  readonly view?: InvocationView;
}

export type InvocationRelationReception = Readonly<{ status: 'pending' } | { status: 'receiving' } | { status: 'accepted'; output: unknown } | { status: 'failed'; error: unknown }>;

/** A direct parent-child relationship, not another invocation or E/O/A execution layer. */
export class InvocationRelation {
  #returned?: InvocationResult<unknown>;
  readonly view: InvocationRelationView;
  #reception: InvocationRelationReception = Object.freeze({ status: 'pending' });

  constructor(
    readonly invocation: InvocationTarget,
    readonly round: number,
    readonly key?: string,
    private readonly failed?: (failure: InvocationFailure) => void,
    private readonly observe?: (change: InvocationRelationChange) => unknown | undefined,
    private readonly validate?: () => void,
  ) {
    const relation = this;
    this.view = Object.freeze({
      get invocation() {
        if (!invocation.view) throw new Error('Child invocation has no business view');
        return invocation.view;
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

  get returned(): InvocationResult<unknown> | undefined {
    return this.#returned;
  }

  get reception(): InvocationRelationReception {
    return this.#reception;
  }

  returnedWith(result: InvocationResult<unknown>): void {
    if (this.#returned) throw new Error('Child invocation has already returned');
    this.#returned = Object.freeze(result);
    if (result.status === 'failed' && result.failure) this.failed?.(result.failure);
    this.observe?.({ kind: 'returned', result: this.#returned });
  }

  async accept<Value>(work: () => Value | Promise<Value>): Promise<Value> {
    this.validate?.();
    if (this.#returned?.status !== 'succeeded') throw new Error('Child invocation has not returned successfully');
    if (this.#reception.status !== 'pending') throw new Error('Child result has already entered acceptance');
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
      output = await work();
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
