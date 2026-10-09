import type { OperationDefinition } from './operation.js';
import type { AttemptDefinition } from './attempt.js';
import type { InvocationView } from '../invocation/view.js';
import type { ExecutionScope } from '../context/scope.js';
import type { OperationScope } from '../context/scope.js';
import type { AttemptScope } from '../context/scope.js';

// Heterogeneous storage erases IO; all public lookup and call sites retain the concrete definition.
export type ChildDefinition = OperationDefinition<any, any, any> | AttemptDefinition<any, any, any>;
export type DefinitionInput<D> = D extends OperationDefinition<infer I, any, any> | AttemptDefinition<infer I, any, any> ? I : never;
export type DefinitionOutput<D> = D extends OperationDefinition<any, infer O, any> | AttemptDefinition<any, infer O, any> ? O : never;
export type DefinitionParent<D> = D extends AttemptDefinition<any, any, any> ? InvocationView<unknown, unknown, OperationScope> : InvocationView<unknown, unknown, ExecutionScope> | InvocationView<unknown, unknown, OperationScope>;
export type DefinitionContext<D> = D extends AttemptDefinition<infer I, infer O, infer R> ? AttemptScope<I, O, R> : D extends OperationDefinition<infer I, infer O, infer R> ? OperationScope<I, O, R> : never;
