import { ProgressChannel } from '../progress.js';
import { RuntimeError } from '../errors/error.js';
import type { InvocationOutputEvent, InvocationOutputWriter, OutputDeclaration } from '@capix/contracts';

/** One producer-owned segment. Delivery is passive and never controls its lifetime. */
export class InvocationOutputSection<Result> {
  readonly writer: InvocationOutputWriter<unknown>;
  #state: 'open' | 'sealed' | 'discarded' | 'completed' = 'open';
  #sequence = 0;
  readonly #delivery?: ProgressChannel<InvocationOutputEvent<Result>>;

  constructor(
    readonly contextId: string,
    readonly round: number,
    private readonly declaration: OutputDeclaration<Result, unknown> | undefined,
    private readonly controls: { active(): void; reject(error: unknown): void },
    delivery?: ProgressChannel<InvocationOutputEvent<Result>>,
  ) {
    this.#delivery = delivery;
    this.writer = Object.freeze({ emit: (value: unknown) => this.emit(value) });
  }

  start(): void {
    this.publish({ kind: 'started' });
    this.controls.active();
  }

  private emit(value: unknown): void {
    if (this.#state !== 'open') throw new RuntimeError('OUTPUT_CLOSED', 'This output writer no longer belongs to an executing segment');
    this.controls.active();
    let delta: unknown;
    try {
      if (!this.declaration?.delta) throw new RuntimeError('OUTPUT_UNDECLARED', 'This declaration does not produce incremental output');
      delta = this.declaration.delta(value);
      rejectPromise(delta);
    } catch (cause) {
      const error = new RuntimeError('OUTPUT_CONTRACT', 'Produced incremental output violates its declaration', undefined, { cause });
      this.controls.reject(error);
      throw error;
    }
    this.controls.active();
    this.publish({ kind: 'delta', delta });
    this.controls.active();
    if (this.#state !== 'open') throw new RuntimeError('OUTPUT_CLOSED', 'The output segment ended during delivery');
  }

  seal(): void {
    if (this.#state !== 'open') return;
    this.#state = 'sealed';
    this.publish({ kind: 'sealed' });
  }

  discard(reason: 'exception' | 'continue' | 'failed'): void {
    if (this.#state === 'discarded' || this.#state === 'completed') return;
    this.#state = 'discarded';
    this.publish({ kind: 'discarded', reason });
  }

  validateResult(value: Result): Result {
    try {
      const result = this.declaration ? this.declaration.result(value) : value;
      if (this.declaration) rejectPromise(result);
      if (result !== value && !Object.is(result, value)) throw new TypeError('Output validation must preserve the final value identity');
      return value;
    } catch (cause) {
      const error = new RuntimeError('OUTPUT_CONTRACT', 'The final output violates its declaration', undefined, { cause });
      this.controls.reject(error);
      throw error;
    }
  }

  complete(result: Result): void {
    if (this.#state === 'open' || this.#state === 'completed') throw new Error('Output segment cannot complete from this state');
    const discarded = this.#state === 'discarded';
    this.#state = 'completed';
    this.publish({ kind: 'completed', result, discarded });
  }

  private publish(event: { kind: 'started' | 'sealed' } | { kind: 'delta'; delta: unknown } | { kind: 'discarded'; reason: 'exception' | 'continue' | 'failed' } | { kind: 'completed'; result: Result; discarded: boolean }): void {
    this.#delivery?.publish(Object.freeze({ ...event, contextId: this.contextId, round: this.round, sequence: ++this.#sequence }));
  }
}

function rejectPromise(value: unknown): void {
  if (value && (typeof value === 'object' || typeof value === 'function') && 'then' in value && typeof value.then === 'function') {
    void Promise.resolve(value).catch(() => undefined);
    throw new TypeError('Output contracts must return synchronously');
  }
}
