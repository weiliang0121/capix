import type { invocationSignature } from './signature.js';
import type { DefinitionParentInvocationView } from './children.js';
import { InvocationDefinition } from './invocation.js';
import type { AttemptContextView } from '../context/view.js';

export abstract class AttemptDefinition<Input, Output, Resources extends object = Record<string, never>, ExceptionResources extends object = Record<string, never>, Delta = never> extends InvocationDefinition<Input, Output, AttemptContextView<Input, Output, Resources>, Resources, ExceptionResources, Delta> {
  declare readonly [invocationSignature]?: (parent: DefinitionParentInvocationView<AttemptDefinition<Input, Output, Resources>>, input: Input) => Output;
  readonly level = 'attempt' as const;
  abstract readonly name: string;
  abstract readonly label: string;
  abstract readonly source: string;
  abstract readonly callee: string;
}
