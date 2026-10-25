import type { ChildReference } from '../children/reference.js';

/** Historical diagnostic vocabulary, isolated from ordinary callable processing. */
export type ExceptionOrigin = { readonly kind: 'self'; readonly phase: 'execute' | 'accept' } | { readonly kind: 'child-return' | 'child-reception'; readonly child: ChildReference };
export interface ContinuationFact {
  readonly fromRound: 1;
  readonly stage: 'accept' | 'handling';
  readonly reason: string;
  readonly origin?: ExceptionOrigin;
}
