/** Type-only declaration signature: definitions cannot create or run invocations. */
export declare const invocationSignature: unique symbol;
export interface InvocationSignature<Input, Output, EntryInput = Input, Delta = never> {
  readonly input: Input;
  readonly output: Output;
  readonly entry: EntryInput;
  readonly delta: Delta;
}
