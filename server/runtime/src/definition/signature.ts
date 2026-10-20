import type { CallableKind } from '@capix/protocol';

/** Type-only callable signature: author structures cannot create or run invocations. */
export declare const invocationSignature: unique symbol;
export interface InvocationSignature<Input, Output, Delta = never> {
  readonly input: Input;
  /** Input is both supplied to calls and read from facts; neither widening nor narrowing is safe. */
  readonly acceptsInput: (input: Input) => void;
  readonly output: Output;
  readonly delta: Delta;
}

/** A consumer view of the original declaration, not sufficient content for binding. */
export interface CallableContract<Kind extends CallableKind = CallableKind, Input = unknown, Output = unknown, Delta = unknown> {
  readonly kind: Kind;
  readonly [invocationSignature]: InvocationSignature<Input, Output, Delta>;
}

type Signature<Definition> = Definition extends { readonly [invocationSignature]?: infer S } ? NonNullable<S> : InvocationSignature<unknown, unknown, unknown>;
export type CallableInput<Callable> = Signature<Callable> extends { readonly input: infer Input } ? Input : unknown;
export type CallableOutput<Callable> = Signature<Callable> extends { readonly output: infer Output } ? Output : unknown;
export type CallableDelta<Callable> = Signature<Callable> extends { readonly delta: infer Delta } ? Delta : never;
