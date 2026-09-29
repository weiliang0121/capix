import type { InvocationContext } from '../context/context.js';
import type { InvocationWork } from './cycle.js';
import type { Continuation, InvocationResult } from './result.js';

/** Reusable behavior only; each call captures its bound work without retaining a live context. */
export abstract class InvocationBehavior<I, O, C extends InvocationContext<I, O>> {
  protected readonly maxRounds: 1 | 2 = 1;

  protected abstract execute(context: C): O | Promise<O>;

  protected receive?(context: C, result: InvocationResult<O>): O | Continuation<I> | Promise<O | Continuation<I>>;

  protected get work(): InvocationWork<C, I, O> {
    return {
      execute: this.execute.bind(this),
      receive: this.receive?.bind(this),
      maxRounds: this.maxRounds,
    };
  }
}
