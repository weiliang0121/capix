import type { OperationOutcome, OperationResult, Reception } from './contract.js';

/** Outcome production and result reception are distinct: never catch a receiver as an operation failure. */
export async function receiveOperation<Value, Failure, Options extends { readonly result?: Reception<Value, Failure, unknown> } = {}>(outcome: OperationOutcome<Value, Failure>, options?: Options): Promise<OperationResult<Value, Options>> {
  if (outcome.status === 'succeeded') {
    return (options?.result?.succeeded ? await options.result.succeeded(outcome.value) : outcome.value) as OperationResult<Value, Options>;
  }
  if (options?.result?.failed) return (await options.result.failed(outcome.failure)) as OperationResult<Value, Options>;
  throw outcome.failure;
}
