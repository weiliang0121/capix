import type { CheckpointRestoration } from '../checkpoint/contract.js';
import { isUndefined } from 'es-toolkit/predicate';
import { Clock } from './clock.js';
import { bindRuntimeStructureObservation } from '../binding/observation.js';
import type { EventConsumer } from '../observation/observer.js';
import type { RuntimeStructureFact } from '../observation/facts.js';
import { randomUUID } from 'node:crypto';
import { DeclaredException } from '../exception/contract.js';
import { RuntimeError } from '../errors/error.js';
import type { RuntimeBinding } from '../binding/contract.js';
import type { InvocationControls } from '../context/context.js';
import type { InvocationCapabilities } from '../invocation/capabilities.js';
import type { RuntimeInvocationBuilder } from '../invocation/runtime/builder.js';

/** Long-lived structure and occupancy; every run owns a separate Context and Invocation. */
export class BoundRuntime<Input = unknown, Output = unknown, Options extends InvocationControls = InvocationControls, Resources extends object = object> {
  readonly id = randomUUID();
  readonly #binding?: RuntimeBinding<Input, Output, Options, Resources>;
  #running = false;
  #sequence = 0;
  readonly #clock: Clock;
  readonly #observation: EventConsumer<RuntimeStructureFact>;

  constructor(
    private readonly invocationBuilder: RuntimeInvocationBuilder,
    binding?: RuntimeBinding<Input, Output, Options, Resources>,
    options: Pick<InvocationCapabilities, 'clock' | 'observations'> = {},
  ) {
    this.#clock = options.clock ?? new Clock();
    this.#binding = binding;
    // The root's own identity is available here; observe establishment only after binding is complete.
    this.#observation = bindRuntimeStructureObservation(this.id, options.observations);
    this.publish({ kind: 'established' });
  }

  get running(): boolean {
    return this.#running;
  }

  private publish(change: { kind: 'established' | 'acquired' | 'released' } | { kind: 'rejected'; reason: 'busy'; error: unknown } | { kind: 'entry-failed'; error: unknown }): void {
    const fault = this.#observation.publish(Object.freeze({ ...change, runtimeId: this.id, sequence: ++this.#sequence, occurredAt: this.#clock.now() }));
    if (!isUndefined(fault)) throw fault;
  }

  async reserve<Value>(work: () => Value | Promise<Value>): Promise<Value> {
    if (this.#running) {
      const error = new RuntimeError('RUNTIME_BUSY', '当前环境正在执行，请等待本次调用结束。');
      try {
        this.publish({ kind: 'rejected', reason: 'busy', error });
      } catch (observation) {
        throw new AggregateError([error, observation], 'Entry rejection and observation both failed', { cause: error });
      }
      throw error;
    }
    this.#running = true;
    let failed = false;
    let failure: unknown;
    try {
      this.publish({ kind: 'acquired' });
      return await work();
    } catch (error) {
      failed = true;
      failure = error;
      throw error;
    } finally {
      this.#running = false;
      try {
        this.publish({ kind: 'released' });
      } catch (observation) {
        if (failed) throw new AggregateError([failure, observation], 'Runtime delivery and release observation both failed', { cause: failure });
        throw observation;
      }
    }
  }

  run(input: Input, options: Options): Promise<Output> {
    return this.perform({ input }, options);
  }

  resume(contextId: string, options: Options): Promise<Output> {
    return this.perform({ contextId }, options);
  }

  private async perform(request: { input: Input } | { contextId: string }, options: Options): Promise<Output> {
    const binding = this.#binding;
    if (!binding) throw new Error('Runtime has no assembled work');
    const work = binding.work;
    try {
      return await this.reserve(() => {
        let invocation;
        try {
          const construct = (input: Input, restore?: CheckpointRestoration) => {
            binding.validate?.(options);
            const definition = binding.declaration;
            const initial = restore ? definition.checkpoint?.points[restore.head.image.point]?.resume.requires : definition.run.requires;
            if (!initial) throw new Error('Checkpoint point is not declared');
            return this.invocationBuilder.create(input, {
              description: { id: this.id },
              controls: options,
              resources: binding.resources(input, options),
              executionBindings: binding.executionBindings(input, options),
              requires: binding.requires,
              initial,
              restore,
              observation: definition.observation,
              work,
              progress: binding.progress?.(input, options),
              output: binding.output?.(input, options),
            });
          };
          invocation = 'contextId' in request ? this.invocationBuilder.restoration(request.contextId, work, (restore) => construct(work.checkpoint!.input.decode(restore.head.image.frame.input), restore)) : construct(request.input);
        } catch (error) {
          try {
            this.publish({ kind: 'entry-failed', error });
          } catch (observation) {
            throw new AggregateError([error, observation], 'Call construction and observation both failed', { cause: error });
          }
          throw error;
        }
        return invocation.run();
      });
    } catch (error) {
      if (error instanceof DeclaredException) throw new RuntimeError('UNHANDLED_EXCEPTION', '运行异常未被接纳处理。', undefined, { cause: error });
      throw error;
    }
  }
}
