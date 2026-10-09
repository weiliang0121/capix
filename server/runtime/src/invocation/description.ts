/** Stable labels of the bound work node, independent of observation output. */
export interface OperationDescription {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly source: string;
}
export interface AttemptDescription {
  readonly name: string;
  readonly label: string;
  readonly source: string;
  readonly callee: string;
}
