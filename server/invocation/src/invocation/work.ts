import type { InvocationCheckpointWork } from '../checkpoint/work.js';
import type { OutputDeclaration } from '@capix/contracts';
import type { Invocation } from './invocation.js';
import type { InvocationContext } from '../context/context.js';
import type { InvocationFailure } from './failure.js';

export interface InvocationWork<Input, Output, Context extends InvocationContext<Input, Output>> {
  readonly output?: OutputDeclaration<Output, unknown>;
  readonly checkpoint?: InvocationCheckpointWork<Input, Output, Context>;
  execute(context: Context, invocation: Invocation<Input, Output, Context>): Output | Promise<Output>;
}

/** Facts produced by the current one-entry execution mechanism. Legacy records are decoded by protocol. */
export type InvocationProcess = { stage: 'execute'; type: 'start'; input: unknown } | { stage: 'execute'; type: 'return'; output: unknown } | { stage: 'execute'; type: 'throw'; error: unknown; failure?: InvocationFailure };

/** Fixed business entry bound to one invocation; no independent acceptance or error interpreter. */
export interface InvocationExecutionWork<Output> {
  readonly output?: OutputDeclaration<Output, unknown>;
  execute(): Output | Promise<Output>;
}

export function connectInvocationWork<Input, Output, Context extends InvocationContext<Input, Output>>(work: InvocationWork<Input, Output, Context>, context: Context, invocation: Invocation<Input, Output, Context>): InvocationExecutionWork<Output> {
  return { output: work.output, execute: () => work.execute(context, invocation) };
}
