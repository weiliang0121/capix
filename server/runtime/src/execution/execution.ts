import type { ResourceRequirements } from '../resource/bindings.js';
import { definitionResources } from '../definition/invocation.js';
import type { ExecutionInvocationBuilder, ExecutionStarted } from '../invocation/execution/builder.js';
import type { ExecutionDefinition } from '../definition/execution.js';
import type { ExecutionContext, ExecutionOptions } from '../context/execution.js';
import type { InvocationWork } from '../invocation/cycle.js';
import type { BoundChildren } from '../binding/children.js';
import type { ResourceBindings } from '../resource/bindings.js';
import { bindInvocationWork } from '../binding/work.js';

export interface ExecutionCallbacks<I, O, R extends object> {
  accepted?(input: I): void;
  started?: ExecutionStarted<I, O, R>;
}
export interface ExecutionAssembly<I, U, P, R extends object, ER extends object> {
  validate?(options: P): void;
  entry(input: U, options: P): ResourceBindings<ER>;
  capture(input: I, options: P): ResourceBindings<R>;
}

/** Bound execution node. Runtime owns reservation; the node owns fixed entry ordering. */
export class Execution<I, O, R extends object = object, U = I, ER extends object = object, P extends ExecutionOptions = ExecutionOptions> {
  private readonly work: InvocationWork<ExecutionContext<I, O, R>, I, O>;
  constructor(
    private readonly invocations: ExecutionInvocationBuilder,
    readonly definition: ExecutionDefinition<I, O, R, U, ER, any>,
    readonly children: BoundChildren,
    private readonly assembly: ExecutionAssembly<I, U, P, R, ER>,
  ) {
    this.work = bindInvocationWork(definition, children);
  }

  async run(input: U, options: P, callbacks: ExecutionCallbacks<I, O, R> = {}): Promise<O> {
    this.assembly.validate?.(options);
    const entry = this.definition.entry;
    let accepted: I;
    if (entry) {
      const resources = this.assembly.entry(input, options);
      let active = true;
      resources.restrict(() => {
        if (!active) throw new Error('Execution entry access has ended');
      });
      try {
        accepted = entry.accept(input, resources.values);
        callbacks.accepted?.(accepted);
        if (!options.signal?.aborted) entry.admit?.(accepted, resources.values);
      } finally {
        active = false;
      }
    } else {
      accepted = input as unknown as I;
      callbacks.accepted?.(accepted);
    }
    const bound = this.assembly.capture(accepted, options);
    return this.invocations
      .create(accepted, {
        context: options,
        requires: definitionResources(this.definition) as ResourceRequirements<R>,
        initial: this.definition.run.requires,
        observation: this.definition.observation,
        establish: () => ({ resources: bound }),
        work: this.work,
        started: callbacks.started,
      })
      .run();
  }
}
