import type { OperationDefinition } from './operation.js';
import type { AttemptDefinition } from './attempt.js';
import type { InvocationView } from '../invocation/view.js';
import type { ExecutionScope } from '../context/scope.js';
import type { OperationScope } from '../context/scope.js';
import type { AttemptScope } from '../context/scope.js';

// Heterogeneous storage erases IO; all public lookup and call sites retain the concrete definition.
export type ChildDefinition = OperationDefinition<any, any, any, any> | AttemptDefinition<any, any, any, any>;
export type DefinitionInput<D> = D extends OperationDefinition<infer I, any, any, any> | AttemptDefinition<infer I, any, any, any> ? I : never;
export type DefinitionOutput<D> = D extends OperationDefinition<any, infer O, any, any> | AttemptDefinition<any, infer O, any, any> ? O : never;
export type DefinitionParent<D> = D extends AttemptDefinition<any, any, any, any> ? InvocationView<unknown, unknown, Omit<OperationScope, 'resources'>> : InvocationView<unknown, unknown, Omit<ExecutionScope, 'resources'>> | InvocationView<unknown, unknown, Omit<OperationScope, 'resources'>>;
export type DefinitionContext<D> = D extends AttemptDefinition<infer I, infer O, infer R, any> ? Omit<AttemptScope<I, O, R>, 'resources'> : D extends OperationDefinition<infer I, infer O, infer R, any> ? Omit<OperationScope<I, O, R>, 'resources'> : never;
