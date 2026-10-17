import type { InvocationLevel } from '@capix/protocol';
import type { OutputDeclaration } from '../output/contract.js';
import type { ExceptionContract } from '../exception/contract.js';
import type { InvocationFact } from '../observation/facts.js';
import type { ObservationDeclaration } from './observation.js';
import type { ChildDefinition } from './children.js';
import type { ChildrenOf, InvocationCheckpointDefinition, ResourceRequests, ResourcesOf } from './checkpoint.js';
import type { AcceptWork, Continue, ExecuteWork, HandleWork, Resolution } from './work.js';
import type { RuntimeDefinition } from './runtime.js';
import type { ExecutionDefinition } from './execution.js';
import type { OperationDefinition } from './operation.js';
import type { AttemptDefinition } from './attempt.js';

type RunAllowed<Children extends readonly ChildDefinition[], Uses extends readonly Children[number][] | undefined> = Uses extends readonly ChildDefinition[] ? Uses[number] : Children[number];
type DefinitionChildren<Level extends InvocationLevel, Children extends readonly ChildrenOf<Level>[]> = Level extends 'attempt' ? { readonly children?: never } : { readonly children?: Children };
type Metadata<Level extends InvocationLevel> = Level extends 'attempt' ? { readonly name: string; readonly label: string; readonly source: string; readonly callee: string } : Level extends 'operation' ? { readonly name: string; readonly label: string; readonly source: string } : { readonly name?: string; readonly label?: string };

interface DefinitionOptions<Level extends InvocationLevel, Input, Output, Children extends readonly ChildrenOf<Level>[], Requires extends ResourceRequests, Uses extends readonly Children[number][] | undefined, ExceptionRequires extends ResourceRequests, ExceptionUses extends readonly Children[number][], Delta> {
  readonly maxRounds?: 1 | 2;
  readonly raises?: readonly ExceptionContract<unknown>[];
  readonly observation?: readonly ObservationDeclaration<InvocationFact>[];
  readonly checkpoint?: InvocationCheckpointDefinition<Input, Output, Level, NoInfer<Delta>>;
  readonly run: {
    readonly requires?: Requires;
    readonly uses?: Uses;
    readonly execute: (work: ExecuteWork<Level, Input, Output, ResourcesOf<Requires>, RunAllowed<Children, Uses>, Delta>) => Output | Promise<Output>;
    readonly accept?: (work: AcceptWork<Level, Input, Output, ResourcesOf<Requires>, RunAllowed<Children, Uses>>) => Output | Continue<Input> | Promise<Output | Continue<Input>>;
  };
  readonly exceptions?: {
    readonly requires?: ExceptionRequires;
    readonly uses?: ExceptionUses;
    readonly accepts: readonly ExceptionContract<unknown>[];
    readonly handle: (work: HandleWork<Level, Input, Output, ResourcesOf<ExceptionRequires>, ExceptionUses[number]>) => Resolution<Input, Output> | Promise<Resolution<Input, Output>>;
  };
}

interface EntryOptions<EntryInput, Input, Requires extends ResourceRequests> {
  readonly requires?: Requires;
  readonly accept: (input: EntryInput, resources: ResourcesOf<Requires>) => Input;
  readonly admit?: (input: Input, resources: ResourcesOf<Requires>) => void;
}
type EntryDeclaration<Level extends InvocationLevel, EntryInput, Input, Requires extends ResourceRequests> = Level extends 'execution' ? ([EntryInput] extends [Input] ? { readonly entry?: EntryOptions<EntryInput, Input, Requires> } : { readonly entry: EntryOptions<EntryInput, Input, Requires> }) : { readonly entry?: never };
type FactoryDefinition<Level extends InvocationLevel, Input, Output, Resources extends object, EntryInput, EntryResources extends object, ExceptionResources extends object, Delta> = Level extends 'runtime' ? RuntimeDefinition<Input, Output, Resources, ExceptionResources, Delta> : Level extends 'execution' ? ExecutionDefinition<Input, Output, Resources, EntryInput, EntryResources, ExceptionResources, Delta> : Level extends 'operation' ? OperationDefinition<Input, Output, Resources, ExceptionResources, Delta> : AttemptDefinition<Input, Output, Resources, ExceptionResources, Delta>;

export interface DefinitionFactory<Level extends InvocationLevel, Input, Output, EntryInput = Input> {
  <Delta, const Children extends readonly ChildrenOf<Level>[] = readonly [], const Requires extends ResourceRequests = Readonly<Record<never, never>>, const Uses extends readonly Children[number][] | undefined = undefined, const ExceptionRequires extends ResourceRequests = Readonly<Record<never, never>>, const ExceptionUses extends readonly Children[number][] = readonly [], const EntryRequires extends ResourceRequests = Readonly<Record<never, never>>>(options: DefinitionOptions<Level, Input, Output, Children, Requires, Uses, ExceptionRequires, ExceptionUses, NoInfer<Delta>> & DefinitionChildren<Level, Children> & Metadata<Level> & EntryDeclaration<Level, EntryInput, Input, EntryRequires> & { readonly output: OutputDeclaration<Output, Delta> & { readonly delta: (value: unknown) => Delta } }): FactoryDefinition<Level, Input, Output, ResourcesOf<Requires>, EntryInput, ResourcesOf<EntryRequires>, ResourcesOf<ExceptionRequires>, Delta>;
  <const Children extends readonly ChildrenOf<Level>[] = readonly [], const Requires extends ResourceRequests = Readonly<Record<never, never>>, const Uses extends readonly Children[number][] | undefined = undefined, const ExceptionRequires extends ResourceRequests = Readonly<Record<never, never>>, const ExceptionUses extends readonly Children[number][] = readonly [], const EntryRequires extends ResourceRequests = Readonly<Record<never, never>>>(options: DefinitionOptions<Level, Input, Output, Children, Requires, Uses, ExceptionRequires, ExceptionUses, never> & DefinitionChildren<Level, Children> & Metadata<Level> & EntryDeclaration<Level, EntryInput, Input, EntryRequires> & { readonly output?: OutputDeclaration<Output, never> }): FactoryDefinition<Level, Input, Output, ResourcesOf<Requires>, EntryInput, ResourcesOf<EntryRequires>, ResourcesOf<ExceptionRequires>, never>;
}

/** Normalize author syntax once; binding still resolves and snapshots each installed position. */
function factory<Level extends InvocationLevel, Input, Output, EntryInput>(level: Level): DefinitionFactory<Level, Input, Output, EntryInput> {
  const create = <Delta, const Children extends readonly ChildrenOf<Level>[] = readonly [], const Requires extends ResourceRequests = Readonly<Record<never, never>>, const Uses extends readonly Children[number][] | undefined = undefined, const ExceptionRequires extends ResourceRequests = Readonly<Record<never, never>>, const ExceptionUses extends readonly Children[number][] = readonly [], const EntryRequires extends ResourceRequests = Readonly<Record<never, never>>>(options: DefinitionOptions<Level, Input, Output, Children, Requires, Uses, ExceptionRequires, ExceptionUses, Delta> & DefinitionChildren<Level, Children> & Metadata<Level> & EntryDeclaration<Level, EntryInput, Input, EntryRequires> & { readonly output?: OutputDeclaration<Output, Delta> }) => {
    const run = options.run;
    const exceptions = options.exceptions;
    const entry = options.entry;
    const definition = {
      ...options,
      level,
      maxRounds: options.maxRounds ?? 1,
      raises: options.raises ?? [],
      ...(level === 'attempt' ? {} : { children: options.children ?? [] }),
      run: { requires: run.requires ?? {}, uses: run.uses, execute: run.execute.bind(run), ...(run.accept ? { accept: run.accept.bind(run) } : {}) },
      ...(exceptions ? { exceptions: { requires: exceptions.requires ?? {}, uses: exceptions.uses, accepts: exceptions.accepts, handle: exceptions.handle.bind(exceptions) } } : {}),
      ...(entry ? { entry: { requires: entry.requires ?? {}, accept: entry.accept.bind(entry), ...(entry.admit ? { admit: entry.admit.bind(entry) } : {}) } } : {}),
    };
    // The only erasure is the generic level-to-class structural correspondence above.
    // Author functions have already been checked against their distinct phase contracts.
    return definition as unknown as FactoryDefinition<Level, Input, Output, ResourcesOf<Requires>, EntryInput, ResourcesOf<EntryRequires>, ResourcesOf<ExceptionRequires>, Delta>;
  };
  return create as DefinitionFactory<Level, Input, Output, EntryInput>;
}

export function defineRuntime<Input, Output>(): DefinitionFactory<'runtime', Input, Output> {
  return factory<'runtime', Input, Output, Input>('runtime');
}
export function defineExecution<Input, Output, EntryInput = Input>(): DefinitionFactory<'execution', Input, Output, EntryInput> {
  return factory<'execution', Input, Output, EntryInput>('execution');
}
export function defineOperation<Input, Output>(): DefinitionFactory<'operation', Input, Output> {
  return factory<'operation', Input, Output, Input>('operation');
}
export function defineAttempt<Input, Output>(): DefinitionFactory<'attempt', Input, Output> {
  return factory<'attempt', Input, Output, Input>('attempt');
}
