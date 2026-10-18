/** Type-only declaration signature: definitions cannot create or run invocations. */
export declare const invocationSignature: unique symbol;
export interface InvocationSignature<Input, Output, Delta = never> {
  readonly input: Input;
  readonly output: Output;
  readonly delta: Delta;
}
