import type { InvocationLevel } from '@capix/protocol';
import type { OutputDeclaration } from '../output/contract.js';
import type { ExceptionContract } from '../exception/contract.js';
import type { InvocationFact } from '../observation/facts.js';
import type { ObservationDeclaration } from './observation.js';
import type { ChildDefinition, ChildrenOf } from './children.js';
import type { InvocationCheckpointDefinition } from './checkpoint.js';
import type { ResourceRequests, ResourcesOf } from '../resource/offer.js';
import type { AcceptWork, Continue, ExecuteWork, HandleWork, Resolution } from './work.js';
import type { RuntimeDefinition } from './runtime.js';
import type { ExecutionDefinition } from './execution.js';
import type { OperationDefinition } from './operation.js';
import type { AttemptDefinition } from './attempt.js';

type RunAllowed<Children extends readonly ChildDefinition[], Uses extends readonly NoInfer<Children[number]>[] | undefined> = Uses extends readonly Children[number][] ? Uses[number] : Children[number];
type FactoryChildren<Level extends InvocationLevel, Children extends readonly ChildrenOf<Level>[]> = Level extends 'attempt' ? { readonly children?: never } : { readonly children?: Children };
type Metadata<Level extends InvocationLevel> = Level extends 'attempt' ? { readonly name: string; readonly label: string; readonly source: string; readonly callee: string } : Level extends 'operation' ? { readonly name: string; readonly label: string; readonly source: string } : { readonly name?: string; readonly label?: string };

interface DefinitionOptions<Level extends InvocationLevel, Input, Output, Children extends readonly ChildrenOf<Level>[], Requires extends ResourceRequests, Uses extends readonly NoInfer<Children[number]>[] | undefined, ExceptionRequires extends ResourceRequests, ExceptionUses extends readonly NoInfer<Children[number]>[], Delta> {
  readonly maxRounds?: 1 | 2;
  readonly raises?: readonly ExceptionContract<unknown>[];
  readonly observation?: readonly ObservationDeclaration<InvocationFact>[];
  readonly checkpoint?: InvocationCheckpointDefinition<Input, Output, Level, NoInfer<Delta>>;
  readonly run: {
    readonly requires?: Requires;
    readonly uses?: Uses;
    readonly execute: (work: ExecuteWork<Level, Input, Output, ResourcesOf<NoInfer<Requires>>, RunAllowed<Children, Uses>, Delta>) => Output | Promise<Output>;
    readonly accept?: (work: AcceptWork<Level, Input, Output, ResourcesOf<NoInfer<Requires>>, RunAllowed<Children, Uses>>) => Output | Continue<Input> | Promise<Output | Continue<Input>>;
  };
  readonly exceptions?: {
    readonly requires?: ExceptionRequires;
    readonly uses?: ExceptionUses;
    readonly accepts: readonly ExceptionContract<unknown>[];
    readonly handle: (work: HandleWork<Level, Input, Output, ResourcesOf<NoInfer<ExceptionRequires>>, ExceptionUses[number]>) => Resolution<Input, Output> | Promise<Resolution<Input, Output>>;
  };
}

type FactoryDefinition<Level extends InvocationLevel, Input, Output, Resources extends object, ExceptionResources extends object, Delta> = Level extends 'runtime' ? RuntimeDefinition<Input, Output, Resources, ExceptionResources, Delta> : Level extends 'execution' ? ExecutionDefinition<Input, Output, Resources, ExceptionResources, Delta> : Level extends 'operation' ? OperationDefinition<Input, Output, Resources, ExceptionResources, Delta> : AttemptDefinition<Input, Output, Resources, ExceptionResources, Delta>;

export interface DefinitionFactory<Level extends InvocationLevel, Input, Output> {
  <Delta, const Children extends readonly ChildrenOf<Level>[] = readonly [], const Requires extends ResourceRequests = Readonly<Record<never, never>>, const Uses extends readonly NoInfer<Children[number]>[] | undefined = undefined, const ExceptionRequires extends ResourceRequests = Readonly<Record<never, never>>, const ExceptionUses extends readonly NoInfer<Children[number]>[] = readonly []>(options: DefinitionOptions<Level, Input, Output, Children, Requires, Uses, ExceptionRequires, ExceptionUses, NoInfer<Delta>> & FactoryChildren<Level, Children> & Metadata<Level> & { readonly output: OutputDeclaration<Output, Delta> & { readonly delta: (value: unknown) => Delta } }): FactoryDefinition<Level, Input, Output, ResourcesOf<NoInfer<Requires>>, ResourcesOf<NoInfer<ExceptionRequires>>, Delta>;
  <const Children extends readonly ChildrenOf<Level>[] = readonly [], const Requires extends ResourceRequests = Readonly<Record<never, never>>, const Uses extends readonly NoInfer<Children[number]>[] | undefined = undefined, const ExceptionRequires extends ResourceRequests = Readonly<Record<never, never>>, const ExceptionUses extends readonly NoInfer<Children[number]>[] = readonly []>(options: DefinitionOptions<Level, Input, Output, Children, Requires, Uses, ExceptionRequires, ExceptionUses, never> & FactoryChildren<Level, Children> & Metadata<Level> & { readonly output?: OutputDeclaration<Output, never> }): FactoryDefinition<Level, Input, Output, ResourcesOf<NoInfer<Requires>>, ResourcesOf<NoInfer<ExceptionRequires>>, never>;
}

/** Normalize author syntax once; binding still resolves and snapshots each installed position. */
function factory<Level extends InvocationLevel, Input, Output>(level: Level): DefinitionFactory<Level, Input, Output> {
  const create = <Delta, const Children extends readonly ChildrenOf<Level>[] = readonly [], const Requires extends ResourceRequests = Readonly<Record<never, never>>, const Uses extends readonly NoInfer<Children[number]>[] | undefined = undefined, const ExceptionRequires extends ResourceRequests = Readonly<Record<never, never>>, const ExceptionUses extends readonly NoInfer<Children[number]>[] = readonly []>(options: DefinitionOptions<Level, Input, Output, Children, Requires, Uses, ExceptionRequires, ExceptionUses, Delta> & FactoryChildren<Level, Children> & Metadata<Level> & { readonly output?: OutputDeclaration<Output, Delta> }) => {
    const run = options.run;
    const exceptions = options.exceptions;
    const definition = {
      ...options,
      level,
      maxRounds: options.maxRounds ?? 1,
      raises: options.raises ?? [],
      ...(level === 'attempt' ? {} : { children: options.children ?? [] }),
      run: { requires: run.requires ?? {}, uses: run.uses, execute: run.execute.bind(run), ...(run.accept ? { accept: run.accept.bind(run) } : {}) },
      ...(exceptions ? { exceptions: { requires: exceptions.requires ?? {}, uses: exceptions.uses, accepts: exceptions.accepts, handle: exceptions.handle.bind(exceptions) } } : {}),
    };
    // Author functions were checked against their distinct phase contracts above.
    // Bridge the generic level-to-class shape and its type-only signature; no symbol is created.
    return definition as unknown as FactoryDefinition<Level, Input, Output, ResourcesOf<Requires>, ResourcesOf<ExceptionRequires>, Delta>;
  };
  return create as DefinitionFactory<Level, Input, Output>;
}

export function defineRuntime<Input, Output>(): DefinitionFactory<'runtime', Input, Output> {
  return factory<'runtime', Input, Output>('runtime');
}
export function defineExecution<Input, Output>(): DefinitionFactory<'execution', Input, Output> {
  return factory<'execution', Input, Output>('execution');
}
export function defineOperation<Input, Output>(): DefinitionFactory<'operation', Input, Output> {
  return factory<'operation', Input, Output>('operation');
}
export function defineAttempt<Input, Output>(): DefinitionFactory<'attempt', Input, Output> {
  return factory<'attempt', Input, Output>('attempt');
}
