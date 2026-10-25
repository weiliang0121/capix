import type { InvocationFailure } from './failure.js';
import type { RuntimeErrorValue } from '@capix/protocol';
export type InvocationResult<Output> = Readonly<{ status: 'succeeded'; output: Output } | { status: 'failed'; error: unknown; failure?: InvocationFailure; diagnostic?: RuntimeErrorValue }>;

export function receiveResult<Output>(result: InvocationResult<Output>): Output {
  if (result.status === 'failed') throw result.error;
  return result.output;
}
