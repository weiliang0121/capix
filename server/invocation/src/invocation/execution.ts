import type { InvocationContext } from '../context/context.js';
import { requireNotCancelled } from './cancellation.js';
import type { InvocationFailure, InvocationPhase } from './failure.js';
import type { InvocationExecutionWork, InvocationProcess } from './work.js';
import { InvocationOutputSection } from '../output/section.js';
import type { InvocationOutputEvent, InvocationOutputReceiver, InvocationOutputWriter, OperationOutcome } from '@capix/contracts';
import { ProgressChannel } from '@capix/changes';
import { stableValue, type Stable } from '@capix/contracts';

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

  completeOutput(output: Stable<Output>): void {
    this.#outputSection?.complete(output);
  }

  /** Recovery selects a declared entry; it never replays the original business function. */
  async run(resume?: () => Output | Stable<Output> | Promise<Output | Stable<Output>>): Promise<OperationOutcome<Stable<Output>, InvocationFailure>> {
    try {
      this.controls.healthy();
      requireNotCancelled(this.options.signal);
      if (!resume) this.context.start();
      this.options.validate?.();
      this.controls.healthy();
      this.#outputSection = new InvocationOutputSection(this.context.id, this.context.progress.round, this.work.output, this.controls, this.#outputDelivery);
      this.#outputSection.start();
      this.options.process({ stage: 'execute', type: 'start', input: this.context.currentInput });
    } catch (error) {
      return this.failed(this.controls.classify(error, 'execute', true));
    }
    let body: OperationOutcome<Stable<Output>>;
    let fixingFailed = false;
    try {
      this.controls.active();
      const candidate = await (resume ? resume() : this.work.execute());
      try {
        // The candidate is fixed before acceptance draining or cleanup can mutate
        // its producer's aliases. This does not establish successful delivery.
        body = { status: 'succeeded', value: stableValue<Output>(candidate) };
      } catch (failure) {
        fixingFailed = true;
        body = { status: 'failed', failure };
      }
    } catch (failure) {
      // Capture only. Installing a body failure here would revoke in-flight receptions.
      body = { status: 'failed', failure };
    }
    // Stay in the body's await continuation: no extra Promise boundary before sealing.
    this.sealOutput();
    const settling = this.controls.settleAcceptances();
    if (settling) await settling;
    // Authenticate the exact body delivery before any cleanup failure can become authoritative.
    let failure = body.status === 'failed' ? this.controls.classify(body.failure, 'execute', fixingFailed) : undefined;
    const closing = this.work.close();
    if (closing.status === 'failed') failure = this.closeFailure(failure, closing.failure);
    if (failure) {
      this.context.returned({ status: 'failed', error: failure.error, failure });
      try {
        this.reportFailure(failure);
      } catch (error) {
        return this.failed({ ...this.controls.classify(error, 'execute', true), error, kind: 'error', receptionAllowed: false });
      }
      return this.failed(failure);
    }
    // The failed branch above always produced a classified failure, even for `throw undefined`.
    if (body.status === 'failed') throw new Error('Missing execution failure classification');
    try {
      let output = body.value;
      this.controls.healthy();
      this.context.returned({ status: 'succeeded', output });
      this.options.process({ stage: 'execute', type: 'return', output });
      this.controls.healthy();
      this.options.validate?.();
      requireNotCancelled(this.options.signal);
      output = this.#outputSection.validateResult(output);
      this.controls.healthy();
      requireNotCancelled(this.options.signal);
      return { status: 'succeeded', value: output };
    } catch (error) {
      return this.failed(this.controls.classify(error, 'execute', true));
    }
  }

  private failed(failure: InvocationFailure): OperationOutcome<never, InvocationFailure> {
    this.#exitFailure = failure;
    return { status: 'failed', failure };
  }

  private closeFailure(body: InvocationFailure | undefined, error: unknown): InvocationFailure {
    const closing = this.controls.classify(error, 'control', true);
    const primary = body ?? closing;
    const delivered = body || closing.error !== error ? new AggregateError([primary.error, error], 'Execution and Work close both failed', { cause: primary.error }) : error;
    this.controls.classify(delivered, 'control', true);
    return Object.freeze({ ...primary, kind: 'error', error: delivered, receptionAllowed: false });
  }

  private reportFailure(failure: InvocationFailure): void {
    try {
      this.options.process({ stage: 'execute', type: 'throw', error: failure.error, failure });
    } catch (reportingError) {
      throw new AggregateError([failure.error, reportingError], 'Failure and its process reporting both failed', { cause: failure.error });
    }
  }
}
