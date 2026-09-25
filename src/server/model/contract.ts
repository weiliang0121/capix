import type { ExecutionContext } from '../context/execution.js';

/** A model output shape and its acceptance rules belong to the concrete work. */
export interface ModelOutputContract<I, O> {
  readonly schema: unknown;
  accept(value: unknown, input: I, execution: ExecutionContext): O;
}
