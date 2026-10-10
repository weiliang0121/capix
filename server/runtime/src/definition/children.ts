import type { ExecutionDefinition } from './execution.js';
import type { OperationDefinition } from './operation.js';
import type { AttemptDefinition } from './attempt.js';
import type { InvocationView } from '../invocation/view.js';
import type { RuntimeContextView, ExecutionContextView, OperationContextView, AttemptContextView } from '../context/view.js';

// Heterogeneous storage erases IO; all public lookup and call sites retain the concrete definition.
export type ChildDefinition = ExecutionDefinition<any, any, any, any, any, any> | OperationDefinition<any, any, any, any> | AttemptDefinition<any, any, any, any>;
export type DefinitionEntryInput<Definition> = Definition extends ExecutionDefinition<any, any, any, infer EntryInput, any, any> ? EntryInput : Definition extends OperationDefinition<infer Input, any, any, any> | AttemptDefinition<infer Input, any, any, any> ? Input : never;
export type DefinitionInvocationInput<Definition> = Definition extends ExecutionDefinition<infer Input, any, any, any, any, any> | OperationDefinition<infer Input, any, any, any> | AttemptDefinition<infer Input, any, any, any> ? Input : never;
export type DefinitionOutput<Definition> = Definition extends ExecutionDefinition<any, infer Output, any, any, any, any> | OperationDefinition<any, infer Output, any, any> | AttemptDefinition<any, infer Output, any, any> ? Output : never;
export type DefinitionParentInvocationView<Definition> = Definition extends ExecutionDefinition<any, any, any, any, any, any> ? InvocationView<unknown, unknown, Omit<RuntimeContextView, 'resources'>> : Definition extends AttemptDefinition<any, any, any, any> ? InvocationView<unknown, unknown, Omit<OperationContextView, 'resources'>> : InvocationView<unknown, unknown, Omit<ExecutionContextView, 'resources'>> | InvocationView<unknown, unknown, Omit<OperationContextView, 'resources'>>;
export type DefinitionContextFacts<Definition> = Definition extends ExecutionDefinition<infer Input, infer Output, infer Resources, any, any, any> ? Omit<ExecutionContextView<Input, Output, Resources>, 'resources'> : Definition extends AttemptDefinition<infer Input, infer Output, infer Resources, any> ? Omit<AttemptContextView<Input, Output, Resources>, 'resources'> : Definition extends OperationDefinition<infer Input, infer Output, infer Resources, any> ? Omit<OperationContextView<Input, Output, Resources>, 'resources'> : never;
