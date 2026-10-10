import type { ResourceRequirements } from '../resource/bindings.js';

/** Type-only call signature: definitions cannot create or run invocations. */
export declare const invocationSignature: unique symbol;
export interface DeclaredCall<Parent, Input, Output> {
  readonly [invocationSignature]?: (parent: Parent, input: Input) => Output;
  readonly run: { readonly requires: ResourceRequirements };
  readonly exceptions?: { readonly requires: ResourceRequirements };
}
