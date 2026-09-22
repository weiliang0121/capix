import { randomUUID } from 'node:crypto';
import { invoke } from '../invocation/invoke.js';
import type { ExecutionContext } from '../context/execution.js';
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
    private readonly runtime: Runtime,
    definition: OperationDefinition,
  ) {
    this.definition = Object.freeze({ ...definition });
  }

  abstract before(input: I): Result<P>;
  abstract commit(prepared: P): Result<R>;
  abstract after(raw: R, input: I): Result<O>;

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
    const prepared = await this.phase(context, 'before', input, (value) => this.before(value));
    const raw = await this.phase(context, 'commit', prepared, (value) => this.commit(value));
    return this.phase(context, 'after', { raw, input }, (value) => this.after(value.raw, value.input));
  }

  private phase<V, T>(context: OperationContext, phase: 'before' | 'commit' | 'after', input: V, execute: (value: V) => Result<T>): Promise<T> {
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
      (attempt) => execute(attempt.input),
    );
  }
}

export function identity<T>(value: T): T {
  return value;
}
