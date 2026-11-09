import type { InvocationFailure } from './failure.js';
import type { RuntimeErrorValue, Stable } from '@weiliang0121/capix-contracts';
export type InvocationResult<Output> = Readonly<{ status: 'succeeded'; output: Stable<Output> } | { status: 'failed'; error: unknown; failure?: InvocationFailure; diagnostic?: Stable<RuntimeErrorValue> }>;

export function receiveResult<Output>(result: InvocationResult<Output>): Stable<Output> {
  if (result.status === 'failed') throw result.error;
  return result.output;
}
