import type { ProgressReceiver } from '../progress.js';

/** Output production belongs to the declaration; accepting it is not a consumer's decision. */
export interface OutputDeclaration<Result, Delta = never> {
  result(value: unknown): Result;
  delta?(value: unknown): Delta;
}

/** A revocable endpoint for one execute phase, never an entire reusable definition. */
export interface InvocationOutputWriter<Delta> {
  emit(delta: Delta): void;
}

export type InvocationOutputEvent<Result = unknown, Delta = unknown> = Readonly<{ contextId: string; round: number; sequence: number } & ({ kind: 'started' | 'sealed' } | { kind: 'delta'; delta: Delta } | { kind: 'discarded'; reason: 'exception' | 'continue' | 'failed' } | { kind: 'completed'; result: Result; discarded: boolean })>;

export type InvocationOutputReceiver<Result = unknown, Delta = unknown> = ProgressReceiver<InvocationOutputEvent<Result, Delta>>;
