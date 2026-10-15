import type { InvocationCheckpointWork } from '../checkpoint/work.js';
import type { OutputDeclaration } from '../output/contract.js';
import type { Invocation } from './invocation.js';
import type { InvocationContext } from '../context/context.js';
import type { Continuation, InvocationResolution } from './result.js';
import type { DeclaredException, ExceptionContract } from '../exception/contract.js';
import type { InvocationFailure } from './failure.js';

export interface InvocationWork<Input, Output, Context extends InvocationContext<Input, Output>> {
  readonly output?: OutputDeclaration<Output, unknown>;
  readonly checkpoint?: InvocationCheckpointWork<Input, Output, Context>;
  execute(context: Context, invocation: Invocation<Input, Output, Context>): Output | Promise<Output>;
  accept?(context: Context, output: Output, invocation: Invocation<Input, Output, Context>): Output | Continuation<Input> | Promise<Output | Continuation<Input>>;
  raises?: readonly ExceptionContract<any>[];
  exceptions?: {
    accepts: readonly ExceptionContract<any>[];
    handle(context: Context, exception: DeclaredException, invocation: Invocation<Input, Output, Context>): InvocationResolution<Input, Output> | Promise<InvocationResolution<Input, Output>>;
  };
  maxRounds: 1 | 2;
}

export type InvocationProcess = { stage: 'execute'; type: 'start'; input: unknown } | { stage: 'execute' | 'receive' | 'handling'; type: 'return'; output: unknown } | { stage: 'receive'; type: 'return'; reuse: true } | { stage: 'execute' | 'receive' | 'handling'; type: 'throw'; error: unknown; failure?: InvocationFailure } | { stage: 'receive' | 'handling'; type: 'continue'; input: unknown; reason: string } | { stage: 'handling'; type: 'start' | 'unhandled'; error: unknown; failure?: InvocationFailure } | { stage: 'control'; type: 'stop'; error: unknown; failure?: InvocationFailure };

/** Call-local work entry points. The cycle cannot access structure, children or checkpoint storage. */
export interface InvocationCycleWork<Input, Output> {
  readonly output?: OutputDeclaration<Output, unknown>;
  readonly maxRounds: 1 | 2;
  execute(): Output | Promise<Output>;
  accept?(output: Output): Output | Continuation<Input> | Promise<Output | Continuation<Input>>;
  readonly exceptions?: {
    readonly accepts: readonly ExceptionContract<any>[];
    handle(exception: DeclaredException): InvocationResolution<Input, Output> | Promise<InvocationResolution<Input, Output>>;
  };
}

/** Connect the reusable work once; absence of accept remains meaningful to the cycle. */
export function connectInvocationWork<Input, Output, Context extends InvocationContext<Input, Output>>(work: InvocationWork<Input, Output, Context>, context: Context, invocation: Invocation<Input, Output, Context>): InvocationCycleWork<Input, Output> {
  const accept = (output: Output) => work.accept!(context, output, invocation);
  const exceptions = {
    get accepts() {
      return work.exceptions!.accepts;
    },
    handle: (exception: DeclaredException) => work.exceptions!.handle(context, exception, invocation),
  };
  return {
    get output() {
      return work.output;
    },
    get maxRounds() {
      return work.maxRounds;
    },
    execute: () => work.execute(context, invocation),
    get accept() {
      return work.accept ? accept : undefined;
    },
    get exceptions() {
      return work.exceptions ? exceptions : undefined;
    },
  };
}
