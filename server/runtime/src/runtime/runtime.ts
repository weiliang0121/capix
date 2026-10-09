import { isUndefined } from 'es-toolkit/predicate';
import { Clock } from './clock.js';
import { bindRuntimeObservation, type EventConsumer } from '../observation/binding.js';
import type { RuntimeFact } from '../observation/facts.js';
import { randomUUID } from 'node:crypto';
import { DeclaredException } from '../exception/contract.js';
import { RuntimeError } from '../errors/error.js';
import { BindingEnvironment } from '../binding/environment.js';
import { bindInvocationWork } from '../binding/work.js';
import { observationResources } from '../definition/invocation.js';
import type { RuntimeDefinition } from '../definition/runtime.js';
import type { BoundChildren } from '../binding/children.js';
import type { ResourceBindings, ResourceRequirements } from '../resource/bindings.js';
import type { RuntimeContext, RuntimeCallOptions, RuntimeExecutionBindings } from '../context/runtime.js';
import type { InvocationCapabilities } from '../invocation/capabilities.js';
import type { InvocationWork } from '../invocation/cycle.js';
import { RuntimeContextBuilder } from '../context/runtime/builder.js';
import { RuntimeInvocationBuilder } from '../invocation/runtime/builder.js';
import { ExecutionContextBuilder } from '../context/execution/builder.js';
import { ExecutionInvocationBuilder } from '../invocation/execution/builder.js';
import { OperationContextBuilder } from '../context/operation/builder.js';
import { OperationInvocationBuilder } from '../invocation/operation/builder.js';
import { AttemptContextBuilder } from '../context/attempt/builder.js';
import { AttemptInvocationBuilder } from '../invocation/attempt/builder.js';

export interface RuntimeBinding<I, O, P, R extends object = object> {
  readonly definition: RuntimeDefinition<I, O, R, any>;
  readonly children: BoundChildren;
  validate?(options: P): void;
  resources(input: I, options: P): ResourceBindings<R>;
  executions(input: I, options: P): RuntimeExecutionBindings;
}

/** Long-lived structure and occupancy; every run owns a separate Context and Invocation. */
export class Runtime<I = unknown, O = unknown, P extends RuntimeCallOptions = RuntimeCallOptions, R extends object = object> {
  readonly id = randomUUID();
  readonly runtimeInvocations: RuntimeInvocationBuilder;
  readonly executionInvocations: ExecutionInvocationBuilder;
  readonly operationInvocations: OperationInvocationBuilder;
  readonly attemptInvocations: AttemptInvocationBuilder;
  readonly environment: BindingEnvironment;
  readonly #binding?: RuntimeBinding<I, O, P, R>;
  readonly #work?: InvocationWork<RuntimeContext<I, O, R>, I, O>;
  #running = false;
  #sequence = 0;
  readonly #clock: Clock;
  readonly #observation: EventConsumer<RuntimeFact>;

  constructor(options: InvocationCapabilities = {}, assemble?: (runtime: Runtime<I, O, P, R>) => RuntimeBinding<I, O, P, R>) {
    this.#clock = options.clock ?? new Clock();
    this.#observation = bindRuntimeObservation(this.id, options.observations);
    const runtimes = new RuntimeContextBuilder();
    const executions = new ExecutionContextBuilder(runtimes);
    const operations = new OperationContextBuilder(executions);
    const attempts = new AttemptContextBuilder(operations);
    this.runtimeInvocations = new RuntimeInvocationBuilder(this.id, runtimes, options);
    this.executionInvocations = new ExecutionInvocationBuilder(executions, options);
    this.operationInvocations = new OperationInvocationBuilder(operations, options);
    this.attemptInvocations = new AttemptInvocationBuilder(attempts, options);
    this.environment = new BindingEnvironment(this.executionInvocations, this.operationInvocations, this.attemptInvocations, observationResources(options.observations), options.observations);
    this.#binding = assemble?.(this);
    if (this.#binding) this.#work = bindInvocationWork(this.#binding.definition, this.#binding.children);
    this.publish({ kind: 'established' });
  }

  get running(): boolean {
    return this.#running;
  }

  private publish(change: { kind: 'established' | 'acquired' | 'released' } | { kind: 'rejected'; reason: 'busy'; error: unknown } | { kind: 'entry-failed'; error: unknown }): void {
    const fault = this.#observation.publish(Object.freeze({ ...change, runtimeId: this.id, sequence: ++this.#sequence, occurredAt: this.#clock.now() }));
    if (!isUndefined(fault)) throw fault;
  }

  async reserve<T>(work: () => T | Promise<T>): Promise<T> {
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

  async run(input: I, options: P): Promise<O> {
    const binding = this.#binding;
    const work = this.#work;
    if (!binding || !work) throw new Error('Runtime has no assembled work');
    try {
      return await this.reserve(() => {
        let invocation;
        try {
          binding.validate?.(options);
          const definition = binding.definition;
          invocation = this.runtimeInvocations.create(input, {
            context: options,
            resources: binding.resources(input, options),
            executions: binding.executions(input, options),
            requires: this.environment.resources(definition) as ResourceRequirements<R>,
            initial: definition.run.requires,
            observation: definition.observation,
            work,
          });
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
