import type { CheckpointRestoration } from '../checkpoint/contract.js';
import type { InvocationOutputReceiver } from '../output/contract.js';
import { isUndefined } from 'es-toolkit/predicate';
import { Clock } from './clock.js';
import { bindRuntimeStructureObservation } from '../binding/observation.js';
import type { EventConsumer } from '../observation/observer.js';
import type { RuntimeStructureFact } from '../observation/facts.js';
import { randomUUID } from 'node:crypto';
import { DeclaredException } from '../exception/contract.js';
import { RuntimeError } from '../errors/error.js';
import { BindingEnvironment } from '../binding/environment.js';
import { bindInvocationWork } from '../binding/work.js';
import { observationResources } from '../binding/resources.js';
import type { RuntimeDefinition } from '../definition/runtime.js';
import type { BoundChildren } from '../binding/children.js';
import type { ResourceBindings, ResourceRequirements } from '../resource/bindings.js';
import type { RuntimeContext, ExecutionBindingResolver } from '../context/runtime.js';
import type { InvocationControls } from '../context/context.js';
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
import type { ProgressReceiver } from '../progress/channel.js';
import type { InvocationProgress } from '../invocation/progress.js';

export interface BoundRuntimeBinding<Input, Output, Options, Resources extends object = object> {
  readonly definition: RuntimeDefinition<Input, Output, Resources, any, any>;
  readonly children: BoundChildren;
  validate?(options: Options): void;
  output?(input: Input, options: Options): InvocationOutputReceiver<Output> | undefined;
  progress?(input: Input, options: Options): ProgressReceiver<InvocationProgress> | undefined;
  resources(input: Input, options: Options): ResourceBindings<Resources>;
  executionBindings(input: Input, options: Options): ExecutionBindingResolver;
}

/** Long-lived structure and occupancy; every run owns a separate Context and Invocation. */
export class BoundRuntime<Input = unknown, Output = unknown, Options extends InvocationControls = InvocationControls, Resources extends object = object> {
  readonly id = randomUUID();
  readonly runtimeInvocationBuilder: RuntimeInvocationBuilder;
  readonly executionInvocationBuilder: ExecutionInvocationBuilder;
  readonly operationInvocationBuilder: OperationInvocationBuilder;
  readonly attemptInvocationBuilder: AttemptInvocationBuilder;
  readonly environment: BindingEnvironment;
  readonly #binding?: BoundRuntimeBinding<Input, Output, Options, Resources>;
  readonly #work?: InvocationWork<Input, Output, RuntimeContext<Input, Output, Resources>>;
  #running = false;
  #sequence = 0;
  readonly #clock: Clock;
  readonly #observation: EventConsumer<RuntimeStructureFact>;

  constructor(options: InvocationCapabilities = {}, assemble?: (runtime: BoundRuntime<Input, Output, Options, Resources>) => BoundRuntimeBinding<Input, Output, Options, Resources>) {
    this.#clock = options.clock ?? new Clock();
    this.#observation = bindRuntimeStructureObservation(this.id, options.observations);
    const runtimeContextBuilder = new RuntimeContextBuilder();
    const executionContextBuilder = new ExecutionContextBuilder(runtimeContextBuilder);
    const operationContextBuilder = new OperationContextBuilder(executionContextBuilder);
    const attemptContextBuilder = new AttemptContextBuilder(operationContextBuilder);
    this.runtimeInvocationBuilder = new RuntimeInvocationBuilder(this.id, runtimeContextBuilder, options);
    this.executionInvocationBuilder = new ExecutionInvocationBuilder(executionContextBuilder, options);
    this.operationInvocationBuilder = new OperationInvocationBuilder(operationContextBuilder, options);
    this.attemptInvocationBuilder = new AttemptInvocationBuilder(attemptContextBuilder, options);
    this.environment = new BindingEnvironment(this.executionInvocationBuilder, this.operationInvocationBuilder, this.attemptInvocationBuilder, observationResources(options.observations), options.observations);
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
    const work = this.#work;
    if (!binding || !work) throw new Error('Runtime has no assembled work');
    try {
      return await this.reserve(() => {
        let invocation;
        try {
          const construct = (input: Input, restore?: CheckpointRestoration) => {
            binding.validate?.(options);
            const definition = binding.definition;
            const initial = restore ? definition.checkpoint?.points[restore.head.image.point]?.resume.requires : definition.run.requires;
            if (!initial) throw new Error('Checkpoint point is not declared');
            return this.runtimeInvocationBuilder.create(input, {
              controls: options,
              resources: binding.resources(input, options),
              executionBindings: binding.executionBindings(input, options),
              requires: this.environment.resources(definition) as ResourceRequirements<Resources>,
              initial,
              restore,
              observation: definition.observation,
              work,
              progress: binding.progress?.(input, options),
              output: binding.output?.(input, options),
            });
          };
          invocation = 'contextId' in request ? this.runtimeInvocationBuilder.restoration(request.contextId, work, (restore) => construct(work.checkpoint!.input.decode(restore.head.image.frame.input), restore)) : construct(request.input);
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
