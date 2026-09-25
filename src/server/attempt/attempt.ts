import { invoke } from '../invocation/invoke.js';
import type { AttemptContext } from '../context/attempt.js';
import type { OperationContext } from '../context/operation.js';
import type { Runtime } from '../runtime/runtime.js';

/** The leaf execution boundary. Internal work uses ordinary functions, not child attempts. */
export abstract class Attempt<I, O> {
  abstract readonly name: string;
  abstract readonly label: string;
  abstract readonly source: string;
  abstract readonly callee: string;

  constructor(protected readonly runtime: Runtime) {}

  call(operation: OperationContext, input: I): Promise<O> {
    return invoke(this.runtime.attempt(operation, this, input), (context) => this.execute(context));
  }

  protected abstract execute(context: AttemptContext<I, O>): O | Promise<O>;
}
