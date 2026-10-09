import type { ExecutionDefinition } from './execution.js';
import type { OperationDefinition } from './operation.js';
import type { AttemptDefinition } from './attempt.js';
import type { InvocationView } from '../invocation/view.js';
import type { RuntimeScope, ExecutionScope, OperationScope, AttemptScope } from '../context/scope.js';

// Heterogeneous storage erases IO; all public lookup and call sites retain the concrete definition.
export type ChildDefinition = ExecutionDefinition<any, any, any, any, any, any> | OperationDefinition<any, any, any, any> | AttemptDefinition<any, any, any, any>;
export type DefinitionInput<D> = D extends ExecutionDefinition<any, any, any, infer U, any, any> ? U : D extends OperationDefinition<infer I, any, any, any> | AttemptDefinition<infer I, any, any, any> ? I : never;
export type DefinitionCallInput<D> = D extends ExecutionDefinition<infer I, any, any, any, any, any> | OperationDefinition<infer I, any, any, any> | AttemptDefinition<infer I, any, any, any> ? I : never;
export type DefinitionOutput<D> = D extends ExecutionDefinition<any, infer O, any, any, any, any> | OperationDefinition<any, infer O, any, any> | AttemptDefinition<any, infer O, any, any> ? O : never;
export type DefinitionParent<D> = D extends ExecutionDefinition<any, any, any, any, any, any> ? InvocationView<unknown, unknown, Omit<RuntimeScope, 'resources'>> : D extends AttemptDefinition<any, any, any, any> ? InvocationView<unknown, unknown, Omit<OperationScope, 'resources'>> : InvocationView<unknown, unknown, Omit<ExecutionScope, 'resources'>> | InvocationView<unknown, unknown, Omit<OperationScope, 'resources'>>;
export type DefinitionContext<D> = D extends ExecutionDefinition<infer I, infer O, infer R, any, any, any> ? Omit<ExecutionScope<I, O, R>, 'resources'> : D extends AttemptDefinition<infer I, infer O, infer R, any> ? Omit<AttemptScope<I, O, R>, 'resources'> : D extends OperationDefinition<infer I, infer O, infer R, any> ? Omit<OperationScope<I, O, R>, 'resources'> : never;
