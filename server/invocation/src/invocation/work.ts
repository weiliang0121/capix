import type { InvocationCheckpointWork } from '../checkpoint/work.js';
import type { OperationOutcome, OutputDeclaration, Stable } from '@capix/contracts';
import { InvocationStopped } from './stop.js';
import type { Invocation } from './invocation.js';
import type { InvocationContext } from '../context/context.js';
import type { InvocationFailure } from './failure.js';

export interface InvocationWork<Input, Output, Context extends InvocationContext<Input, Output>> {
  readonly output?: OutputDeclaration<Output, unknown>;
  readonly checkpoint?: InvocationCheckpointWork<Input, Output, Context>;
  execute(context: Context, invocation: Invocation<Input, Output, Context>): Output | Stable<Output> | Promise<Output | Stable<Output>>;
  /** Mechanism port: synchronously revoke this entry's Work after started receptions drain. */
  close?(context: Context, invocation: Invocation<Input, Output, Context>): OperationOutcome<void>;
}

/** Facts produced by the current one-entry execution mechanism. Legacy records are decoded by protocol. */
export type InvocationProcess = { stage: 'execute'; type: 'start'; input: unknown } | { stage: 'execute'; type: 'return'; output: unknown } | { stage: 'execute'; type: 'throw'; error: unknown; failure?: InvocationFailure };

/** Fixed business entry bound to one invocation; no independent acceptance or error interpreter. */
export interface InvocationExecutionWork<Output> {
  readonly output?: OutputDeclaration<Output, unknown>;
  execute(): Output | Stable<Output> | Promise<Output | Stable<Output>>;
  close(): OperationOutcome<void>;
}

export function connectInvocationWork<Input, Output, Context extends InvocationContext<Input, Output>>(work: InvocationWork<Input, Output, Context>, context: Context, invocation: Invocation<Input, Output, Context>): InvocationExecutionWork<Output> {
  return { output: work.output, execute: () => work.execute(context, invocation), close: () => closeInvocationWork(work, context, invocation) };
}

/** A custom low-level port cannot escape the synchronous, value-returning close boundary. */
function closeInvocationWork<Input, Output, Context extends InvocationContext<Input, Output>>(work: InvocationWork<Input, Output, Context>, context: Context, invocation: Invocation<Input, Output, Context>): OperationOutcome<void> {
  try {
    if (work.close === undefined) return { status: 'succeeded', value: undefined };
    const result: unknown = work.close(context, invocation);
    if (result && typeof result === 'object' && 'then' in result) {
      void Promise.resolve(result).catch(() => undefined);
      throw new InvocationStopped('INVALID_WORK_CLOSE', 'Work close must return a synchronous outcome');
    }
    if (!result || typeof result !== 'object' || !('status' in result)) throw new InvocationStopped('INVALID_WORK_CLOSE', 'Work close must return an outcome');
    if (result.status === 'succeeded' && 'value' in result && result.value === undefined) return { status: 'succeeded', value: undefined };
    if (result.status === 'failed' && 'failure' in result) return { status: 'failed', failure: result.failure };
    throw new InvocationStopped('INVALID_WORK_CLOSE', 'Work close returned an invalid outcome');
  } catch (failure) {
    return { status: 'failed', failure };
  }
}
