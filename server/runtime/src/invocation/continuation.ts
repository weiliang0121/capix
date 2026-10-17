import type { InvocationExceptionOrigin } from './provenance.js';

/** Accepted control fact. Constructing a continuation proposal does not create this fact. */
export interface InvocationContinuationFact {
  readonly fromRound: 1;
  readonly stage: 'accept' | 'handling';
  readonly reason: string;
  readonly origin?: InvocationExceptionOrigin;
}
