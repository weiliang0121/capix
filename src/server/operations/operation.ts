import { randomUUID } from 'node:crypto';
import { invoke } from '../invocation/invoke.js';
import type { ExecutionContext } from '../context/execution.js';
import type { AttemptContext } from '../context/attempt.js';
import type { OperationContext } from '../context/operation.js';
import type { Runtime } from '../runtime/runtime.js';

type Result<T> = T | Promise<T>;

/** Callable BCA implementation. Each call owns its Context and intermediate values. */
export abstract class Operation<I, BeforeOutput, CommitOutput, O> {
  readonly id = randomUUID();
  abstract readonly name: string;
  abstract readonly label: string;
  abstract readonly source: string;
  protected abstract readonly phaseSource: string;
  protected readonly remote: boolean = false;

  constructor(protected readonly runtime: Runtime) {}

  abstract before(input: I, context: AttemptContext<I, BeforeOutput>): Result<BeforeOutput>;
  abstract commit(input: BeforeOutput, context: AttemptContext<BeforeOutput, CommitOutput>): Result<CommitOutput>;
  abstract after(input: CommitOutput, context: AttemptContext<CommitOutput, O>): Result<O>;

  call(execution: ExecutionContext, input: I, parent?: OperationContext): Promise<O> {
    return invoke(this.runtime.operation<I, BeforeOutput, CommitOutput, O>(execution, this, input, parent), (context) => this.execute(context));
  }

  private async execute(context: OperationContext<I, O>): Promise<O> {
    const beforeOutput = await this.phase<I, BeforeOutput>(context, 'before', context.input, (input, attempt) => this.before(input, attempt));
    const commitOutput = await this.phase<BeforeOutput, CommitOutput>(context, 'commit', beforeOutput, (input, attempt) => this.commit(input, attempt));
    return this.phase<CommitOutput, O>(context, 'after', commitOutput, (input, attempt) => this.after(input, attempt));
  }

  private phase<V, T>(context: OperationContext, phase: 'before' | 'commit' | 'after', input: V, execute: (value: V, context: AttemptContext<V, T>) => Result<T>): Promise<T> {
    return invoke(this.runtime.attempt<V, T>(context, phase, input, `${this.phaseSource} · ${phase}`, phase === 'commit' && this.remote ? 'provider' : 'processing'), (attempt) => execute(attempt.input, attempt));
  }
}

export function identity<T>(value: T): T {
  return value;
}
