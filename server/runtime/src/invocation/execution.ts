import type { InvocationContext } from '../context/context.js';
import { requireNotCancelled } from './cancellation.js';
import type { InvocationFailure, InvocationPhase } from './failure.js';
import type { InvocationExecutionWork, InvocationProcess } from './work.js';
import { InvocationOutputSection } from '../output/section.js';
import type { InvocationOutputEvent, InvocationOutputReceiver, InvocationOutputWriter } from '@capix/contracts';
import { ProgressChannel } from '../progress.js';

export interface InvocationExecutionControls {
  healthy(): void;
  active(): void;
  reject(error: unknown): void;
  classify(error: unknown, phase: InvocationPhase, forceError?: boolean): InvocationFailure;
  settleAcceptances(): Promise<void> | undefined;
}

export interface InvocationExecutionOptions<Output> {
  readonly signal: AbortSignal;
  readonly process: (process: InvocationProcess) => void;
  readonly validate?: () => void;
  readonly output?: InvocationOutputReceiver<Output>;
}

/** One business entry, one output section, one final result. Business branching stays in run. */
export class InvocationExecution<Input, Output> {
  #outputSection?: InvocationOutputSection<Output>;
  readonly #outputDelivery?: ProgressChannel<InvocationOutputEvent<Output>>;
  #exitFailure?: InvocationFailure;

  constructor(
    private readonly context: InvocationContext<Input, Output>,
    private readonly work: InvocationExecutionWork<Output>,
    private readonly controls: InvocationExecutionControls,
    private readonly options: InvocationExecutionOptions<Output>,
  ) {
    this.#outputDelivery = options.output ? new ProgressChannel(options.output) : undefined;
  }

  get outputWriter(): InvocationOutputWriter<unknown> {
    if (!this.#outputSection) throw new Error('Invocation has no executing output segment');
    return this.#outputSection.writer;
  }

  get exitFailure(): InvocationFailure | undefined {
    return this.#exitFailure;
  }

  sealOutput(): void {
    this.#outputSection?.seal();
  }

  discardOutput(reason: 'failed' | 'exception'): void {
    this.#outputSection?.discard(reason);
  }

  completeOutput(output: Output): void {
    this.#outputSection?.complete(output);
  }

  /** Recovery selects a declared entry; it never replays the original business function. */
  async run(resume?: () => Promise<Output>): Promise<Output> {
    this.controls.healthy();
    requireNotCancelled(this.options.signal);
    if (!resume) this.context.start();
    this.options.validate?.();
    this.controls.healthy();
    this.#outputSection = new InvocationOutputSection(this.context.id, this.context.progress.round, this.work.output, this.controls, this.#outputDelivery);
    this.#outputSection.start();
    this.options.process({ stage: 'execute', type: 'start', input: this.context.currentInput });
    let output: Output;
    try {
      this.controls.active();
      output = await (resume ? resume() : this.work.execute());
      this.controls.healthy();
    } catch (error) {
      const failure = this.controls.classify(error, 'execute');
      this.#exitFailure = failure;
      this.context.returned({ status: 'failed', error: failure.error, failure });
      this.reportFailure(failure);
      throw failure.error;
    } finally {
      this.sealOutput();
      const settling = this.controls.settleAcceptances();
      if (settling) await settling;
    }
    this.context.returned({ status: 'succeeded', output });
    this.options.process({ stage: 'execute', type: 'return', output });
    this.controls.healthy();
    this.options.validate?.();
    requireNotCancelled(this.options.signal);
    output = this.#outputSection.validateResult(output);
    this.controls.healthy();
    requireNotCancelled(this.options.signal);
    return output;
  }

  private reportFailure(failure: InvocationFailure): void {
    try {
      this.options.process({ stage: 'execute', type: 'throw', error: failure.error, failure });
    } catch (reportingError) {
      throw new AggregateError([failure.error, reportingError], 'Failure and its process reporting both failed', { cause: failure.error });
    }
  }
}
