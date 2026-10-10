import type { invocationSignature } from './signature.js';
import type { DefinitionParentInvocationView } from './children.js';
import { InvocationDefinition } from './invocation.js';
import type { OperationContextView } from '../context/view.js';
import type { ChildDefinition } from './children.js';

export abstract class OperationDefinition<Input, Output, Resources extends object = Record<string, never>, ExceptionResources extends object = Record<string, never>> extends InvocationDefinition<Input, Output, OperationContextView<Input, Output, Resources>, Resources, ExceptionResources> {
  declare readonly [invocationSignature]?: (parent: DefinitionParentInvocationView<OperationDefinition<Input, Output, Resources>>, input: Input) => Output;
  readonly level = 'operation' as const;
  readonly children: readonly ChildDefinition[] = [];
  abstract readonly name: string;
  abstract readonly label: string;
  abstract readonly source: string;
}
