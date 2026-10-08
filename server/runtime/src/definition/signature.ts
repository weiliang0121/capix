import type { ResourceRequirements } from '../resource/bindings.js';

/** Type-only call signature: definitions cannot create or run invocations. */
export declare const invocationSignature: unique symbol;
export interface DeclaredCall<P, I, O> {
  readonly [invocationSignature]?: (parent: P, input: I) => O;
  readonly requires: ResourceRequirements;
}
