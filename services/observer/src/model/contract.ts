import type { ExecutionContext } from '@capix-observer/runtime';

/** A model output shape and its acceptance rules belong to the concrete work. */
export interface ModelOutputContract<I, O> {
  readonly schema: unknown;
  accept(value: unknown, input: I, execution: ExecutionContext): O;
}
