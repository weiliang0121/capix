import type { Stable } from '@weiliang0121/capix-contracts';

/** A model output shape and its acceptance rules belong to the concrete work. */
export interface ModelOutputContract<Basis, Output> {
  readonly schema: unknown;
  accept(value: unknown, basis: Stable<Basis>): Output;
}
