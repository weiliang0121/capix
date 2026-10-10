/** A model output shape and its acceptance rules belong to the concrete work. */
export interface ModelOutputContract<Basis, Output> {
  readonly schema: unknown;
  accept(value: unknown, basis: Basis): Output;
}
