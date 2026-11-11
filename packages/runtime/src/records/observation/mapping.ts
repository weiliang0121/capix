import type { RecordedInvocationResult } from '@weiliang0121/capix-protocol';
import { RuntimeErrorHelper, failureFact, type InvocationResult } from '@weiliang0121/capix-invocation';
import type { InvocationRecordDescription } from './declaration.js';

export function recordedResult(result: InvocationResult<unknown>, description?: InvocationRecordDescription): RecordedInvocationResult {
  if (result.status === 'succeeded') return { status: 'succeeded', output: description?.output ? description.output(result.output) : result.output };
  return { status: 'failed', error: RuntimeErrorHelper.format(result.error), ...(result.failure ? { failure: failureFact(result.failure) } : {}) };
}
