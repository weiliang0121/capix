import { ExceptionContract } from '@capix/invocation';
import type { ModelOutput } from './types.js';

export interface ModelOutputRejection {
  readonly code: 'INVALID_JSON' | 'EMPTY_OUTPUT' | 'OUTPUT_SHAPE';
  readonly output: ModelOutput;
}

/** A complete model return rejected by the output contract, distinct from invocation failures. */
export const modelOutputRejected = new ExceptionContract<ModelOutputRejection>('MODEL_OUTPUT_REJECTED');
