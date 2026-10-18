import type { InvocationContext } from '../context/context.js';
import { Continuation, type InvocationResult, type InvocationResolution } from './result.js';
import { InvocationStopped } from './stop.js';
import { requireNotCancelled } from './cancellation.js';
import { DeclaredException } from '../exception/contract.js';
import type { InvocationFailure, InvocationPhase } from './failure.js';
import type { InvocationCycleWork, InvocationProcess } from './work.js';
import { InvocationOutputSection } from '../output/section.js';
import type { InvocationOutputEvent, InvocationOutputReceiver, InvocationOutputWriter } from '../output/contract.js';
import { ProgressChannel } from '../progress.js';
import { isNonBlankString } from '../value/string.js';
import { isObject } from '../value/object.js';
import type { InvocationContinuationFact } from './continuation.js';

/** The cycle shares the call's error authority, without access to its structure or delivery. */
export interface InvocationCycleControls {
  healthy(): void;
  active(): void;
  reject(error: unknown): void;
  classify(error: unknown, phase: InvocationPhase, forceError?: boolean): InvocationFailure;
  settleAcceptances(): Promise<void> | undefined;
}

export interface InvocationCycleOptions<Output> {
  readonly signal: AbortSignal;
  readonly process: (process: InvocationProcess, round?: number) => void;
  readonly validate?: () => void;
  readonly output?: InvocationOutputReceiver<Output>;
}

/** Local execute/receive/handling rounds and their output segments. Context owns semantic progress. */
export class InvocationCycle<Input, Output> {
  #outputSection?: InvocationOutputSection<Output>;
  readonly #outputDelivery?: ProgressChannel<InvocationOutputEvent<Output>>;
  #exceptionFailure?: InvocationFailure;
  #exitFailure?: InvocationFailure;
  #continuation?: InvocationContinuationFact;

  constructor(
    private readonly context: InvocationContext<Input, Output>,
    private readonly work: InvocationCycleWork<Input, Output>,
    private readonly controls: InvocationCycleControls,
    private readonly options: InvocationCycleOptions<Output>,
  ) {
    this.#outputDelivery = options.output ? new ProgressChannel(options.output) : undefined;
  }

  get outputWriter(): InvocationOutputWriter<unknown> {
    if (!this.#outputSection) throw new Error('Invocation has no executing output segment');
    return this.#outputSection.writer;
  }

  get exceptionFailure(): InvocationFailure | undefined {
    return this.#exceptionFailure;
  }

  get exitFailure(): InvocationFailure | undefined {
    return this.#exitFailure;
  }

  sealOutput(): void {
    this.#outputSection?.seal();
  }

  discardOutput(reason: 'exception' | 'continue' | 'failed'): void {
    this.#outputSection?.discard(reason);
  }

  completeOutput(output: Output): void {
    this.#outputSection?.complete(output);
  }

  /** A continuation entry replaces only the first execute, preserving installed Context progress. */
  async run(resume?: () => Promise<Output>): Promise<Output> {
    let input = resume ? this.context.currentInput : this.context.input;
    const initialRound = resume ? this.context.progress.round : 1;
    try {
      if (this.work.maxRounds !== 1 && this.work.maxRounds !== 2) throw new InvocationStopped('INVALID_ROUND_LIMIT', '本地调用只允许一轮或两轮执行。');
      for (let round = initialRound; round <= this.work.maxRounds; round++) {
        const restoredRound = !!resume && round === initialRound;
        this.enterRound(round, input, restoredRound);
        const accepted = await this.runRound(restoredRound ? resume : undefined);
        this.controls.healthy();
        if (!(accepted instanceof Continuation)) return this.validateOutput(accepted);
        this.discardOutput('continue');
        if (round === this.work.maxRounds) throw new InvocationStopped('LOCAL_ROUND_LIMIT', '本地执行已达到轮次上限。', { maxRounds: this.work.maxRounds });
        if (!this.#continuation || !isNonBlankString(accepted.reason)) throw new InvocationStopped('INVALID_CONTINUATION', '继续执行必须说明原因。');
        this.controls.healthy();
        requireNotCancelled(this.options.signal);
        this.context.installContinuation(accepted.input, this.#continuation);
        // This reports the accepted transition from the previous round. Notification
        // failure cannot erase the next round and continuation already installed.
        this.options.process({ stage: this.#continuation.stage === 'accept' ? 'receive' : 'handling', type: 'continue', input: accepted.input, reason: accepted.reason }, round);
        input = accepted.input;
      }
      throw new InvocationStopped('INTERNAL_ERROR', '调用没有产生结果。');
    } catch (error) {
      if (error instanceof InvocationStopped) this.reportFailure('control', this.controls.classify(error, 'control'));
      throw error;
    }
  }

  private enterRound(round: number, input: Input, restored: boolean): void {
    this.controls.healthy();
    requireNotCancelled(this.options.signal);
    if (!restored && round === 1) this.context.startRound(round, input);
    this.options.validate?.();
    this.controls.healthy();
  }

  private async runRound(resume?: () => Promise<Output>): Promise<Output | Continuation<Input>> {
    this.#continuation = undefined;
    this.#exceptionFailure = undefined;
    this.#exitFailure = undefined;
    this.#outputSection = new InvocationOutputSection(this.context.id, this.context.progress.round, this.work.output, this.controls, this.#outputDelivery);
    this.#outputSection.start();
    this.options.process({ stage: 'execute', type: 'start', input: this.context.currentInput });
    let result: InvocationResult<Output>;
    try {
      this.controls.active();
      const output = await (resume ? resume() : this.work.execute());
      this.controls.healthy();
      result = { status: 'succeeded', output };
    } catch (error) {
      const failure = this.controls.classify(error, 'execute');
      result = { status: 'failed', error: failure.error, failure };
    } finally {
      this.sealOutput();
      const settling = this.controls.settleAcceptances();
      if (settling) await settling;
    }
    // Active receptions finish in their issuing phase; output has already been sealed.
    return this.receiveWork(result);
  }

  private receiveWork(result: InvocationResult<Output>): Promise<Output | Continuation<Input>> {
    if (result.status === 'failed') this.#exitFailure = result.failure;
    this.context.receiving(result);
    if (result.status === 'succeeded') this.options.process({ stage: 'execute', type: 'return', output: result.output });
    else this.reportFailure('execute', result.failure!);
    this.controls.healthy();
    this.options.validate?.();
    requireNotCancelled(this.options.signal);
    this.controls.healthy();
    return result.status === 'failed' ? this.handleException(result.failure!) : this.acceptOutput(result.output);
  }

  private async acceptOutput(output: Output): Promise<Output | Continuation<Input>> {
    let accepted: Output | Continuation<Input>;
    try {
      accepted = this.work.accept ? await this.work.accept(output) : output;
      const settling = this.controls.settleAcceptances();
      if (settling) await settling;
      this.controls.healthy();
    } catch (error) {
      const settling = this.controls.settleAcceptances();
      if (settling) await settling;
      const failure = this.controls.classify(error, 'receive');
      this.#exitFailure = failure;
      this.reportFailure('receive', failure);
      return this.handleException(failure);
    }
    if (accepted instanceof Continuation) this.#continuation = Object.freeze({ fromRound: 1, stage: 'accept', reason: accepted.reason });
    else this.options.process(this.work.accept ? { stage: 'receive', type: 'return', output: accepted } : { stage: 'receive', type: 'return', reuse: true });
    return accepted;
  }

  private async handleException(failure: InvocationFailure): Promise<Output | Continuation<Input>> {
    this.discardOutput('exception');
    const exception = failure.error;
    if (failure.kind !== 'exception' || !(exception instanceof DeclaredException) || !this.work.exceptions?.accepts.includes(exception.contract)) throw exception;
    this.#exceptionFailure = failure;
    this.context.handling();
    this.options.process({ stage: 'handling', type: 'start', error: exception, failure });
    let resolution: InvocationResolution<Input, Output>;
    try {
      this.controls.active();
      resolution = await this.work.exceptions.handle(exception);
      const settling = this.controls.settleAcceptances();
      if (settling) await settling;
      this.controls.healthy();
      if (!isObject(resolution) || !['return', 'continue', 'unhandled'].includes(resolution.kind) || (resolution.kind === 'return' && !Object.hasOwn(resolution, 'output')) || (resolution.kind === 'continue' && (!Object.hasOwn(resolution, 'input') || !isNonBlankString(resolution.reason)))) throw new InvocationStopped('INVALID_EXCEPTION_RESOLUTION', '异常处理返回了无效的处理结果。');
    } catch (error) {
      const settling = this.controls.settleAcceptances();
      if (settling) await settling;
      const handlerFailure = this.controls.classify(error, 'handling', true);
      this.#exitFailure = handlerFailure;
      this.reportFailure('handling', handlerFailure);
      throw handlerFailure.error;
    }
    if (resolution.kind === 'unhandled') {
      this.options.process({ stage: 'handling', type: 'unhandled', error: exception, failure });
      throw exception;
    }
    if (resolution.kind === 'return') {
      this.options.process({ stage: 'handling', type: 'return', output: resolution.output });
      return resolution.output;
    }
    const continuation = new Continuation(resolution.input, resolution.reason);
    this.#continuation = Object.freeze({ fromRound: 1, stage: 'handling', reason: continuation.reason, origin: failure.origin });
    return continuation;
  }

  private validateOutput(value: Output): Output {
    // Acceptance may already have committed a result when it requests cancellation.
    // Only a new cancellation during declaration validation interrupts this boundary.
    const cancelledBeforeValidation = this.options.signal.aborted;
    const output = this.#outputSection ? this.#outputSection.validateResult(value) : value;
    this.controls.healthy();
    if (!cancelledBeforeValidation) requireNotCancelled(this.options.signal);
    return output;
  }

  private reportFailure(stage: 'execute' | 'receive' | 'handling' | 'control', failure: InvocationFailure): void {
    try {
      this.options.process(stage === 'control' ? { stage, type: 'stop', error: failure.error, failure } : { stage, type: 'throw', error: failure.error, failure });
    } catch (reportingError) {
      throw new AggregateError([failure.error, reportingError], 'Failure and its process reporting both failed', { cause: failure.error });
    }
  }
}
