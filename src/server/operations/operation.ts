import { randomUUID } from 'node:crypto';
import { invoke } from '../invocation/invoke.js';
import type { ExecutionContext } from '../context/execution.js';
import type { AttemptContext } from '../context/attempt.js';
import type { OperationContext } from '../context/operation.js';
import type { Runtime } from '../runtime/runtime.js';

type Result<T> = T | Promise<T>;
export interface OperationDefinition {
  readonly name: string;
  readonly label: string;
  readonly source: string;
  readonly phaseSource: string;
  readonly remote?: boolean;
}

/** Callable BCA implementation. Each call owns its Context and intermediate values. */
export abstract class Operation<I, BeforeOutput, CommitOutput, O> {
  readonly id = randomUUID();
  readonly definition: Readonly<OperationDefinition>;
  constructor(
    protected readonly runtime: Runtime,
    definition: OperationDefinition,
  ) {
    this.definition = Object.freeze({ ...definition });
  }

  abstract before(input: I, context: AttemptContext<I, BeforeOutput>): Result<BeforeOutput>;
  abstract commit(input: BeforeOutput, context: AttemptContext<BeforeOutput, CommitOutput>): Result<CommitOutput>;
  abstract after(input: CommitOutput, context: AttemptContext<CommitOutput, O>): Result<O>;

  call(execution: ExecutionContext, input: I, parent?: OperationContext): Promise<O> {
    return invoke(
      this.runtime.operation<I, O>(
        execution,
        {
          operationInstanceId: this.id,
          operation: this.definition.name,
          label: this.definition.label,
          source: this.definition.source,
          caller: parent ? 'operation' : 'execution',
          callee: 'operation',
        },
        input,
        parent,
      ),
      (context) => this.execute(context),
    );
  }

  private async execute(context: OperationContext<I, O>): Promise<O> {
    const beforeOutput = await this.phase<I, BeforeOutput>(context, 'before', context.input, (input, attempt) => this.before(input, attempt));
    const commitOutput = await this.phase<BeforeOutput, CommitOutput>(context, 'commit', beforeOutput, (input, attempt) => this.commit(input, attempt));
    return this.phase<CommitOutput, O>(context, 'after', commitOutput, (input, attempt) => this.after(input, attempt));
  }

  private phase<V, T>(context: OperationContext, phase: 'before' | 'commit' | 'after', input: V, execute: (value: V, context: AttemptContext<V, T>) => Result<T>): Promise<T> {
    return invoke(
      this.runtime.attempt<V, T>(
        context,
        {
          phase,
          source: `${this.definition.phaseSource} · ${phase}`,
          caller: 'operation',
          callee: phase === 'commit' && this.definition.remote ? 'provider' : 'processing',
        },
        input,
      ),
      (attempt) => execute(attempt.input, attempt),
    );
  }
}

export function identity<T>(value: T): T {
  return value;
}
