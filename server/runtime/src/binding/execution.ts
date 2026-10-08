import { bindInvocationWork } from './work.js';
import type { ExecutionDefinition } from '../definition/execution.js';
import type { BoundChildren } from './children.js';
import type { ExecutionOptions } from '../context/execution.js';
import type { ExecutionStarted, ExecutionEnvironment } from '../invocation/execution/builder.js';
import type { Execution } from '../execution/execution.js';

export class ExecutionBinding<I, O, R extends object, P extends ExecutionOptions> {
  constructor(
    readonly structure: Execution<I, O, R>,
    readonly definition: ExecutionDefinition<I, O, R>,
    readonly children: BoundChildren,
    private readonly establish: (input: I, options: P) => ExecutionEnvironment<R>,
    private readonly validate?: (options: P) => void,
  ) {}
  call(input: I, options: P, started?: ExecutionStarted<I, O, R>) {
    return this.submit(() => input, options, started);
  }
  submit(accept: () => I, options: P, started?: ExecutionStarted<I, O, R>) {
    return this.structure.submit(accept, {
      context: options,
      requires: this.definition.requires,
      work: bindInvocationWork(this.definition, this.children),
      establish: (input) => this.establish(input, options),
      validate: this.validate ? () => this.validate!(options) : undefined,
      started,
    });
  }
}
