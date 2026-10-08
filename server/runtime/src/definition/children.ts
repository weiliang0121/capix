import type { OperationDefinition } from './operation.js';
import type { AttemptDefinition } from './attempt.js';
import type { Invocation } from '../invocation/invocation.js';
import type { ExecutionContext } from '../context/execution.js';
import type { OperationContext } from '../context/operation.js';
import type { AttemptContext } from '../context/attempt.js';

// Heterogeneous storage erases IO; all public lookup and call sites retain the concrete definition.
export type ChildDefinition = OperationDefinition<any, any, any> | AttemptDefinition<any, any, any>;
export type DefinitionInput<D> = D extends OperationDefinition<infer I, any, any> | AttemptDefinition<infer I, any, any> ? I : never;
export type DefinitionOutput<D> = D extends OperationDefinition<any, infer O, any> | AttemptDefinition<any, infer O, any> ? O : never;
export type DefinitionParent<D> = D extends AttemptDefinition<any, any, any> ? Invocation<unknown, unknown, OperationContext> : Invocation<unknown, unknown, ExecutionContext> | Invocation<unknown, unknown, OperationContext>;
export type DefinitionContext<D> = D extends AttemptDefinition<infer I, infer O, infer R> ? AttemptContext<I, O, R> : D extends OperationDefinition<infer I, infer O, infer R> ? OperationContext<I, O, R> : never;
