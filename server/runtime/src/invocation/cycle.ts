import type { Invocation } from './invocation.js';
import type { InvocationContext } from '../context/context.js';
import { Continuation, type InvocationResult, type InvocationResolution } from './result.js';
import { InvocationStopped } from './stop.js';
import { requireNotCancelled } from './cancellation.js';
import { DeclaredException, type ExceptionContract } from '../exception/contract.js';
import type { InvocationFailure } from './failure.js';
import { isNonBlankString } from '../value/string.js';
import { isObject } from '../value/object.js';

export type InvocationProcess = { stage: 'execute'; type: 'start'; input: unknown } | { stage: 'execute' | 'receive' | 'handling'; type: 'return'; output: unknown } | { stage: 'receive'; type: 'return'; reuse: true } | { stage: 'execute' | 'receive' | 'handling'; type: 'throw'; error: unknown; failure?: InvocationFailure } | { stage: 'receive' | 'handling'; type: 'continue'; input: unknown; reason: string } | { stage: 'handling'; type: 'start' | 'unhandled'; error: unknown; failure?: InvocationFailure } | { stage: 'control'; type: 'stop'; error: unknown; failure?: InvocationFailure };
type ProcessSink = (process: InvocationProcess) => void;
export interface InvocationCycleOptions {
  signal: AbortSignal;
  onProcess: ProcessSink;
  validate?: () => void;
}
export interface InvocationWork<Input, Output, Context extends InvocationContext<Input, Output>> {
  execute(context: Context, invocation: Invocation<Input, Output, Context>): Output | Promise<Output>;
  accept?(context: Context, output: Output, invocation: Invocation<Input, Output, Context>): Output | Continuation<Input> | Promise<Output | Continuation<Input>>;
  raises?: readonly ExceptionContract<any>[];
  exceptions?: {
    accepts: readonly ExceptionContract<any>[];
    handle(context: Context, exception: DeclaredException, invocation: Invocation<Input, Output, Context>): InvocationResolution<Input, Output> | Promise<InvocationResolution<Input, Output>>;
  };
  maxRounds: 1 | 2;
}

/** Structure decides when facets run; declarations only provide work and explicit handling decisions. */
export async function cycle<Input, Output, Context extends InvocationContext<Input, Output>>(invocation: Invocation<Input, Output, Context>, work: InvocationWork<Input, Output, Context>, options: InvocationCycleOptions): Promise<Output> {
  const context = invocation.context;
  const { signal, onProcess } = options;
  let input = context.input;
  try {
    if (work.maxRounds !== 1 && work.maxRounds !== 2) throw new InvocationStopped('INVALID_ROUND_LIMIT', '本地调用只允许一轮或两轮执行。');
    for (let round = 1; round <= work.maxRounds; round++) {
      invocation.requireHealthy();
      requireNotCancelled(signal);
      context.startRound(round, input);
      options.validate?.();
      invocation.requireHealthy();
      onProcess({ stage: 'execute', type: 'start', input });
      let result: InvocationResult<Output>;
      try {
        invocation.requireActive();
        const output = await work.execute(context, invocation);
        invocation.requireHealthy();
        result = { status: 'succeeded', output };
      } catch (error) {
        const failure = invocation.classify(error, 'execute');
        result = { status: 'failed', error: failure.error, failure };
      }
      context.receiving(result);
      if (result.status === 'succeeded') onProcess({ stage: 'execute', type: 'return', output: result.output });
      else reportFailure(onProcess, 'execute', result.failure!);
      invocation.requireHealthy();
      options.validate?.();
      requireNotCancelled(signal);
      invocation.requireHealthy();
      const accepted = result.status === 'failed' ? await handle(invocation, work, result.failure!, onProcess) : await accept(invocation, work, result.output, onProcess);
      invocation.requireHealthy();
      if (!(accepted instanceof Continuation)) return accepted;
      if (round === work.maxRounds) throw new InvocationStopped('LOCAL_ROUND_LIMIT', '本地执行已达到轮次上限。', { maxRounds: work.maxRounds });
      input = accepted.input;
    }
    throw new InvocationStopped('INTERNAL_ERROR', '调用没有产生结果。');
  } catch (error) {
    if (error instanceof InvocationStopped) reportFailure(onProcess, 'control', invocation.classify(error, 'control'));
    throw error;
  }
}

async function accept<Input, Output, Context extends InvocationContext<Input, Output>>(invocation: Invocation<Input, Output, Context>, work: InvocationWork<Input, Output, Context>, output: Output, onProcess: ProcessSink): Promise<Output | Continuation<Input>> {
  let accepted: Output | Continuation<Input>;
  try {
    accepted = work.accept ? await work.accept(invocation.context, output, invocation) : output;
    invocation.requireHealthy();
  } catch (error) {
    const failure = invocation.classify(error, 'receive');
    reportFailure(onProcess, 'receive', failure);
    return handle(invocation, work, failure, onProcess);
  }
  if (accepted instanceof Continuation) reportContinuation(onProcess, 'receive', accepted);
  else onProcess(work.accept ? { stage: 'receive', type: 'return', output: accepted } : { stage: 'receive', type: 'return', reuse: true });
  return accepted;
}

async function handle<Input, Output, Context extends InvocationContext<Input, Output>>(invocation: Invocation<Input, Output, Context>, work: InvocationWork<Input, Output, Context>, failure: InvocationFailure, onProcess: ProcessSink): Promise<Output | Continuation<Input>> {
  const exception = failure.error;
  if (failure.kind !== 'exception' || !(exception instanceof DeclaredException) || !work.exceptions?.accepts.includes(exception.contract)) throw exception;
  const context = invocation.context;
  context.handling();
  onProcess({ stage: 'handling', type: 'start', error: exception, failure });
  let resolution: InvocationResolution<Input, Output>;
  try {
    invocation.requireActive();
    resolution = await work.exceptions.handle(context, exception, invocation);
    invocation.requireHealthy();
    if (!isObject(resolution) || !['return', 'continue', 'unhandled'].includes(resolution.kind) || (resolution.kind === 'return' && !Object.hasOwn(resolution, 'output')) || (resolution.kind === 'continue' && (!Object.hasOwn(resolution, 'input') || !isNonBlankString(resolution.reason)))) throw new InvocationStopped('INVALID_EXCEPTION_RESOLUTION', '异常处理返回了无效的处理结果。');
  } catch (error) {
    const handlerFailure = invocation.classify(error, 'handling', true);
    reportFailure(onProcess, 'handling', handlerFailure);
    throw handlerFailure.error;
  }
  if (resolution.kind === 'unhandled') {
    onProcess({ stage: 'handling', type: 'unhandled', error: exception, failure });
    throw exception;
  }
  if (resolution.kind === 'return') {
    onProcess({ stage: 'handling', type: 'return', output: resolution.output });
    return resolution.output;
  }
  const continuation = new Continuation(resolution.input, resolution.reason);
  reportContinuation(onProcess, 'handling', continuation);
  return continuation;
}
function reportContinuation<Input>(onProcess: ProcessSink, stage: 'receive' | 'handling', continuation: Continuation<Input>): void {
  if (!isNonBlankString(continuation.reason)) throw new InvocationStopped('INVALID_CONTINUATION', '继续执行必须说明原因。');
  onProcess({ stage, type: 'continue', input: continuation.input, reason: continuation.reason });
}
function reportFailure(onProcess: ProcessSink, stage: 'execute' | 'receive' | 'handling' | 'control', failure: InvocationFailure): void {
  try {
    onProcess(stage === 'control' ? { stage, type: 'stop', error: failure.error, failure } : { stage, type: 'throw', error: failure.error, failure });
  } catch (reportingError) {
    throw new AggregateError([failure.error, reportingError], 'Failure and its process reporting both failed', { cause: failure.error });
  }
}
