/** A model output shape and its acceptance rules belong to the concrete work. */
export interface ModelOutputContract<B, O> {
  readonly schema: unknown;
  accept(value: unknown, basis: B): O;
}
