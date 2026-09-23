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
export abstract class Operation<I, P, R, O> {
  readonly id = randomUUID();
  readonly definition: Readonly<OperationDefinition>;
  constructor(
    protected readonly runtime: Runtime,
    definition: OperationDefinition,
  ) {
    this.definition = Object.freeze({ ...definition });
  }

  abstract before(input: I, context: AttemptContext): Result<P>;
  abstract commit(prepared: P, context: AttemptContext): Result<R>;
  abstract after(raw: R, input: I, context: AttemptContext): Result<O>;

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
    const input = context.input;
    const prepared = await this.phase(context, 'before', input, (value, attempt) => this.before(value, attempt));
    const raw = await this.phase(context, 'commit', prepared, (value, attempt) => this.commit(value, attempt));
    return this.phase(context, 'after', { raw, input }, (value, attempt) => this.after(value.raw, value.input, attempt));
  }

  private phase<V, T>(context: OperationContext, phase: 'before' | 'commit' | 'after', input: V, execute: (value: V, context: AttemptContext) => Result<T>): Promise<T> {
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
