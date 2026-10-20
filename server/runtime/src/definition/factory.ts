import type { CallableKind } from '@capix/protocol';
import type { OutputDeclaration } from '../output/contract.js';
import type { ExceptionContract } from '../exception/contract.js';
import type { InvocationFact } from '../observation/facts.js';
import type { ObservationDeclaration } from './observation.js';
import type { ChildDefinition, ChildrenOf } from './children.js';
import type { InvocationCheckpointDefinition } from './checkpoint.js';
import type { ResourceRequests, ResourcesOf } from '../resource/offer.js';
import type { AcceptWork, Continue, ExecuteWork, HandleWork, Resolution } from './work.js';
import type { SceneDefinition } from './scene.js';
import type { GroupDefinition } from './group.js';
import type { NodeDefinition } from './node.js';
import type { ReceptionRegistration } from './reception.js';

type RunAllowed<Children extends readonly ChildDefinition[], Uses extends readonly NoInfer<Children[number]>[] | undefined> = Uses extends readonly Children[number][] ? Uses[number] : Children[number];
type FactoryMembers<Kind extends CallableKind, Children extends readonly ChildrenOf<Kind>[]> = Kind extends 'node' ? { readonly members?: never } : { readonly members?: Children };
interface Metadata {
  readonly name?: string;
  readonly label?: string;
  readonly source?: string;
  readonly callee?: string;
}

interface DefinitionOptions<Kind extends CallableKind, Input, Output, Children extends readonly ChildrenOf<Kind>[], Requires extends ResourceRequests, Uses extends readonly NoInfer<Children[number]>[] | undefined, ExceptionRequires extends ResourceRequests, ExceptionUses extends readonly NoInfer<Children[number]>[], Delta> {
  readonly maxRounds?: 1 | 2;
  readonly raises?: readonly ExceptionContract<unknown>[];
  readonly observation?: readonly ObservationDeclaration<InvocationFact>[];
  readonly checkpoint?: InvocationCheckpointDefinition<Input, Output, Kind, NoInfer<Delta>>;
  readonly receptions?: Kind extends 'node' ? never : readonly ReceptionRegistration<NoInfer<Children[number]>>[];
  readonly run: {
    readonly requires?: Requires;
    readonly uses?: Uses;
    readonly execute: (work: ExecuteWork<Kind, Input, Output, ResourcesOf<NoInfer<Requires>>, RunAllowed<Children, Uses>, Delta>) => Output | Promise<Output>;
    readonly accept?: (work: AcceptWork<Kind, Input, Output, ResourcesOf<NoInfer<Requires>>, RunAllowed<Children, Uses>>) => Output | Continue<Input> | Promise<Output | Continue<Input>>;
  };
  readonly exceptions?: {
    readonly requires?: ExceptionRequires;
    readonly uses?: ExceptionUses;
    readonly accepts: readonly ExceptionContract<unknown>[];
    readonly handle: (work: HandleWork<Kind, Input, Output, ResourcesOf<NoInfer<ExceptionRequires>>, ExceptionUses[number]>) => Resolution<Input, Output> | Promise<Resolution<Input, Output>>;
  };
}

type FactoryDefinition<Kind extends CallableKind, Input, Output, Resources extends object, ExceptionResources extends object, Delta> = Kind extends 'scene' ? SceneDefinition<Input, Output, Resources, ExceptionResources, Delta> : Kind extends 'group' ? GroupDefinition<Input, Output, Resources, ExceptionResources, Delta> : NodeDefinition<Input, Output, Resources, ExceptionResources, Delta>;

export interface DefinitionFactory<Kind extends CallableKind, Input, Output> {
  <Delta, const Children extends readonly ChildrenOf<Kind>[] = readonly [], const Requires extends ResourceRequests = Readonly<Record<never, never>>, const Uses extends readonly NoInfer<Children[number]>[] | undefined = undefined, const ExceptionRequires extends ResourceRequests = Readonly<Record<never, never>>, const ExceptionUses extends readonly NoInfer<Children[number]>[] = readonly []>(options: DefinitionOptions<Kind, Input, Output, Children, Requires, Uses, ExceptionRequires, ExceptionUses, NoInfer<Delta>> & FactoryMembers<Kind, Children> & Metadata & { readonly output: OutputDeclaration<Output, Delta> & { readonly delta: (value: unknown) => Delta } }): FactoryDefinition<Kind, Input, Output, ResourcesOf<NoInfer<Requires>>, ResourcesOf<NoInfer<ExceptionRequires>>, Delta>;
  <const Children extends readonly ChildrenOf<Kind>[] = readonly [], const Requires extends ResourceRequests = Readonly<Record<never, never>>, const Uses extends readonly NoInfer<Children[number]>[] | undefined = undefined, const ExceptionRequires extends ResourceRequests = Readonly<Record<never, never>>, const ExceptionUses extends readonly NoInfer<Children[number]>[] = readonly []>(options: DefinitionOptions<Kind, Input, Output, Children, Requires, Uses, ExceptionRequires, ExceptionUses, never> & FactoryMembers<Kind, Children> & Metadata & { readonly output?: OutputDeclaration<Output, never> }): FactoryDefinition<Kind, Input, Output, ResourcesOf<NoInfer<Requires>>, ResourcesOf<NoInfer<ExceptionRequires>>, never>;
}

/** Normalize author syntax once; binding still resolves and snapshots each installed position. */
function factory<Kind extends CallableKind, Input, Output>(kind: Kind): DefinitionFactory<Kind, Input, Output> {
  const create = <Delta, const Children extends readonly ChildrenOf<Kind>[] = readonly [], const Requires extends ResourceRequests = Readonly<Record<never, never>>, const Uses extends readonly NoInfer<Children[number]>[] | undefined = undefined, const ExceptionRequires extends ResourceRequests = Readonly<Record<never, never>>, const ExceptionUses extends readonly NoInfer<Children[number]>[] = readonly []>(options: DefinitionOptions<Kind, Input, Output, Children, Requires, Uses, ExceptionRequires, ExceptionUses, Delta> & FactoryMembers<Kind, Children> & Metadata & { readonly output?: OutputDeclaration<Output, Delta> }) => {
    const run = options.run;
    const exceptions = options.exceptions;
    const definition = {
      ...options,
      kind,
      maxRounds: options.maxRounds ?? 1,
      raises: options.raises ?? [],
      ...(kind === 'node' ? {} : { members: options.members ?? [] }),
      run: { requires: run.requires ?? {}, uses: run.uses, execute: run.execute.bind(run), ...(run.accept ? { accept: run.accept.bind(run) } : {}) },
      ...(exceptions ? { exceptions: { requires: exceptions.requires ?? {}, uses: exceptions.uses, accepts: exceptions.accepts, handle: exceptions.handle.bind(exceptions) } } : {}),
    };
    // Author functions were checked against their distinct phase contracts above.
    // Bridge the generic kind-to-class shape and its type-only signature; no symbol is created.
    return definition as unknown as FactoryDefinition<Kind, Input, Output, ResourcesOf<Requires>, ResourcesOf<ExceptionRequires>, Delta>;
  };
  return create as DefinitionFactory<Kind, Input, Output>;
}

export function defineScene<Input, Output>(): DefinitionFactory<'scene', Input, Output> {
  return factory<'scene', Input, Output>('scene');
}
export function defineGroup<Input, Output>(): DefinitionFactory<'group', Input, Output> {
  return factory<'group', Input, Output>('group');
}
export function defineNode<Input, Output>(): DefinitionFactory<'node', Input, Output> {
  return factory<'node', Input, Output>('node');
}
