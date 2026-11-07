import type { Stable } from './value.js';
/** Output production belongs to the declaration; accepting it is not a consumer's decision. */
export interface OutputDeclaration<Result, Delta = never> {
  result(value: unknown): Result | Stable<Result>;
  delta?(value: unknown): Delta | Stable<Delta>;
}

/** A revocable endpoint for one execution, never an entire reusable structure. */
export interface InvocationOutputWriter<Delta> {
  emit(delta: Delta | Stable<Delta>): void;
}

export type InvocationOutputEvent<Result = unknown, Delta = unknown> = Readonly<{ contextId: string; round: number; sequence: number } & ({ kind: 'started' | 'sealed' } | { kind: 'delta'; delta: Stable<Delta> } | { kind: 'discarded'; reason: 'exception' | 'continue' | 'failed' } | { kind: 'completed'; result: Stable<Result>; discarded: boolean })>;

/** Passive synchronous consumption; execution owns publication and failure isolation. */
export interface ProgressReceiver<Fact> {
  receive(fact: Readonly<Fact>): undefined;
  failed?(error: unknown): undefined;
}

export type InvocationOutputReceiver<Result = unknown, Delta = unknown> = ProgressReceiver<InvocationOutputEvent<Result, Delta>>;
