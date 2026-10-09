import type { InvocationFailure } from './failure.js';
import type { InvocationRelationView, InvocationView } from './view.js';
import type { InvocationContext } from '../context/context.js';
import type { InvocationResult } from './result.js';

export interface InvocationRelationOptions {
  /** Work position in a composition, not the reusable behavior's identity. */
  key?: string;
}

export interface InvocationTarget<O = unknown> {
  readonly context: InvocationContext<unknown, O>;
  run(): Promise<O>;
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
  }

  async accept<T>(work: () => T | Promise<T>): Promise<T> {
    if (this.#returned?.status !== 'succeeded') throw new Error('Child invocation has not returned successfully');
    if (this.#reception.status !== 'pending') throw new Error('Child result has already entered acceptance');
    this.#reception = Object.freeze({ status: 'receiving' });
    try {
      const output = await work();
      this.#reception = Object.freeze({ status: 'accepted', output });
      return output;
    } catch (error) {
      this.#reception = Object.freeze({ status: 'failed', error });
      throw error;
    }
  }
}
