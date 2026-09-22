import { randomUUID } from 'node:crypto';
import { invoke } from './invocation/invoke.js';
import { runOperation, type Operation } from './operations/operation.js';
import type { ExecutionContext } from './context/execution.js';
import type { OperationContext } from './context/operation.js';
import type { Runtime } from './runtime/runtime.js';

export interface NodeDefinition {
  readonly name: string;
  readonly label: string;
  readonly source: string;
  readonly phaseSource: string;
  readonly remote?: boolean;
}
/** Reusable binding. Invocation identities and intermediate values stay local to call(). */
export class Node<I, P, R, O> {
  readonly id = randomUUID();
  constructor(
    private readonly operation: Operation<I, P, R, O>,
    private readonly runtime: Runtime,
    private readonly definition: NodeDefinition,
  ) {}
  call(execution: ExecutionContext, input: I, parentOperation?: OperationContext): Promise<O> {
    const { runtime, definition, operation } = this;
    return invoke(
      runtime.operation<I, O>(
        execution,
        {
          nodeId: this.id,
          operation: definition.name,
          label: definition.label,
          source: definition.source,
          caller: 'pipeline',
          callee: 'operation',
        },
        input,
        parentOperation,
      ),
      (context) => {
        const value = context.input;
        const phase = <V, T>(name: 'before' | 'commit' | 'after', value: V, execute: (value: V) => T | Promise<T>) =>
          invoke(
            runtime.attempt<V, T>(
              context,
              {
                phase: name,
                source: `${definition.phaseSource} · ${name}`,
                caller: 'operation',
                callee: name === 'commit' && definition.remote ? 'provider' : 'processing',
              },
              value,
            ),
            (attempt) => execute(attempt.input),
          );
        return runOperation<I, P, R, O>(
          {
            before: (value) => phase('before', value, (value) => operation.before(value)),
            commit: (prepared) => phase('commit', prepared, (value) => operation.commit(value)),
            after: (raw, original) => phase('after', { raw, input: original }, (value) => operation.after(value.raw, value.input)),
          },
          value,
        );
      },
    );
  }
}
/** Local assembly only; no global registry, execution or records are created here. */
export function registerNode<I, P, R, O>(optFactory: () => Operation<I, P, R, O>, runtime: Runtime, definition: NodeDefinition): Node<I, P, R, O> {
  return new Node(optFactory(), runtime, definition);
}
