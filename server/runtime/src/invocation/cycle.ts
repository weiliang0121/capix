import type { RuntimeContext } from '../context/context.js';
import { Continuation, receiveResult, type InvocationResult } from './result.js';
import { InvocationStopped, mustStop } from './stop.js';
import { isNonBlankString } from '../value/string.js';

export type InvocationProcess = { stage: 'execute'; type: 'start'; input: unknown } | { stage: 'execute' | 'receive'; type: 'return'; output: unknown } | { stage: 'receive'; type: 'return'; reuse: true } | { stage: 'execute' | 'receive'; type: 'throw'; error: unknown } | { stage: 'receive'; type: 'continue'; input: unknown; reason: string } | { stage: 'control'; type: 'stop'; error: unknown };

type RecordProcess = (process: InvocationProcess) => void;

export interface InvocationWork<C, I, O> {
  execute(context: C): O | Promise<O>;
  receive?(context: C, result: InvocationResult<O>): O | Continuation<I> | Promise<O | Continuation<I>>;
  maxRounds: 1 | 2;
}

/** Local control only; each receiver owns the meaning of its branches. */
export async function cycle<I, O, C extends RuntimeContext<I, O>>(context: C, work: InvocationWork<C, I, O>, signal: AbortSignal, record: RecordProcess): Promise<O> {
  let input = context.input;
  try {
    requireRoundLimit(work.maxRounds);
    for (let round = 1; round <= work.maxRounds; round++) {
      requireNotCancelled(signal);
      context.startRound(round, input);
      const result = await execute(context, work.execute, record);
      const received = await receive(context, result, work.receive, record);
      if (!(received instanceof Continuation)) return received;
      if (round === work.maxRounds) throw new InvocationStopped('LOCAL_ROUND_LIMIT', '本地执行已达到轮次上限。', { maxRounds: work.maxRounds });
      input = received.input;
    }
    throw new InvocationStopped('INTERNAL_ERROR', '调用没有产生结果。');
  } catch (error) {
    if (error instanceof InvocationStopped) recordFailure(record, 'control', error);
    throw error;
  }
}

async function execute<I, O, C extends RuntimeContext<I, O>>(context: C, work: InvocationWork<C, I, O>['execute'], record: RecordProcess): Promise<InvocationResult<O>> {
  record({ stage: 'execute', type: 'start', input: context.currentInput });
  let result: InvocationResult<O>;
  try {
    result = { status: 'succeeded', output: await work(context) };
  } catch (error) {
    result = { status: 'failed', error };
  }
  context.receiving(result);
  if (result.status === 'succeeded') record({ stage: 'execute', type: 'return', output: result.output });
  else recordFailure(record, 'execute', result.error);
  if (result.status === 'failed' && mustStop(result.error)) throw result.error;
  return result;
}

async function receive<I, O, C extends RuntimeContext<I, O>>(context: C, result: InvocationResult<O>, work: InvocationWork<C, I, O>['receive'], record: RecordProcess): Promise<O | Continuation<I>> {
  let received: O | Continuation<I>;
  try {
    received = work ? await work(context, result) : receiveResult(result);
  } catch (error) {
    recordFailure(record, 'receive', error);
    if ((result.status === 'failed' && Object.is(result.error, error)) || mustStop(error)) throw error;
    throw new InvocationStopped('RECEIVE_FAILED', '接收处理失败，停止本地调用。', undefined, { cause: error });
  }
  if (received instanceof Continuation) {
    if (!isNonBlankString(received.reason)) throw new InvocationStopped('INVALID_CONTINUATION', '继续执行必须说明原因。');
    record({ stage: 'receive', type: 'continue', input: received.input, reason: received.reason });
  } else record(work ? { stage: 'receive', type: 'return', output: received } : { stage: 'receive', type: 'return', reuse: true });
  return received;
}

function requireRoundLimit(limit: number): void {
  if (limit !== 1 && limit !== 2) throw new InvocationStopped('INVALID_ROUND_LIMIT', '本地调用只允许一轮或两轮执行。');
}

function requireNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new InvocationStopped('INVOCATION_CANCELLED', '调用已取消，不再开始下一轮。', undefined, { cause: signal.reason });
}

function recordFailure(record: RecordProcess, stage: 'execute' | 'receive' | 'control', error: unknown): void {
  try {
    record(stage === 'control' ? { stage, type: 'stop', error } : { stage, type: 'throw', error });
  } catch (registrationError) {
    throw new AggregateError([error, registrationError], 'Failure and its process registration both failed', { cause: error });
  }
}
