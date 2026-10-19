import type { InvocationLevel } from '@capix/protocol';

/** Type-only declaration signature: definitions cannot create or run invocations. */
export declare const invocationSignature: unique symbol;
export interface InvocationSignature<Input, Output, Delta = never> {
  readonly input: Input;
  /** Input is both supplied to calls and read from facts; neither widening nor narrowing is safe. */
  readonly acceptsInput: (input: Input) => void;
  readonly output: Output;
  readonly delta: Delta;
}

/** A consumer view of the original declaration, not sufficient content for binding. */
export interface DefinitionContract<Level extends InvocationLevel = InvocationLevel, Input = unknown, Output = unknown, Delta = unknown> {
  readonly level: Level;
  readonly [invocationSignature]: InvocationSignature<Input, Output, Delta>;
}

type Signature<Definition> = Definition extends { readonly [invocationSignature]?: infer S } ? NonNullable<S> : InvocationSignature<unknown, unknown, unknown>;
export type DefinitionInput<Definition> = Signature<Definition> extends { readonly input: infer Input } ? Input : unknown;
export type DefinitionOutput<Definition> = Signature<Definition> extends { readonly output: infer Output } ? Output : unknown;
export type DefinitionDelta<Definition> = Signature<Definition> extends { readonly delta: infer Delta } ? Delta : never;
