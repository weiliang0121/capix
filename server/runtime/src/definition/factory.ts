import type { CallableKind } from '@capix/protocol';
import type { OutputDeclaration } from '../output/contract.js';
import type { ExceptionContract } from '../exception/contract.js';
import type { InvocationFact } from '../observation/facts.js';
import type { ObservationDeclaration } from './observation.js';
import type { ChildCallable, ChildrenOf } from './children.js';
import type { InvocationCheckpointDefinition } from './checkpoint.js';
import type { ResourceRequests, ResourcesOf } from '../resource/offer.js';
import type { AcceptWork, Continue, ExecuteWork, HandleWork, Resolution } from './work.js';
import { Scene } from '../structure/scene.js';
import { Group } from '../structure/group.js';
import { Node } from '../structure/node.js';
import type { ReceptionRegistration } from './reception.js';
import type { Callable } from '../structure/callable.js';
import type { InferredCallableDefinition } from './callable.js';

type RunAllowed<Children extends readonly ChildCallable[], Uses extends readonly NoInfer<Children[number]>[] | undefined> = Uses extends readonly Children[number][] ? Uses[number] : Children[number];
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

type FactoryDefinition<Kind extends CallableKind, Input, Output, Resources extends object, ExceptionResources extends object, Delta> = Kind extends 'scene' ? Scene<Input, Output, Resources, ExceptionResources, Delta> : Kind extends 'group' ? Group<Input, Output, Resources, ExceptionResources, Delta> : Node<Input, Output, Resources, ExceptionResources, Delta>;

export interface DefinitionFactory<Kind extends CallableKind, Input, Output> {
  <Delta, const Children extends readonly ChildrenOf<Kind>[] = readonly [], const Requires extends ResourceRequests = Readonly<Record<never, never>>, const Uses extends readonly NoInfer<Children[number]>[] | undefined = undefined, const ExceptionRequires extends ResourceRequests = Readonly<Record<never, never>>, const ExceptionUses extends readonly NoInfer<Children[number]>[] = readonly []>(options: DefinitionOptions<Kind, Input, Output, Children, Requires, Uses, ExceptionRequires, ExceptionUses, NoInfer<Delta>> & FactoryMembers<Kind, Children> & Metadata & { readonly output: OutputDeclaration<Output, Delta> & { readonly delta: (value: unknown) => Delta } }): FactoryDefinition<Kind, Input, Output, ResourcesOf<NoInfer<Requires>>, ResourcesOf<NoInfer<ExceptionRequires>>, Delta>;
  <const Children extends readonly ChildrenOf<Kind>[] = readonly [], const Requires extends ResourceRequests = Readonly<Record<never, never>>, const Uses extends readonly NoInfer<Children[number]>[] | undefined = undefined, const ExceptionRequires extends ResourceRequests = Readonly<Record<never, never>>, const ExceptionUses extends readonly NoInfer<Children[number]>[] = readonly []>(options: DefinitionOptions<Kind, Input, Output, Children, Requires, Uses, ExceptionRequires, ExceptionUses, never> & FactoryMembers<Kind, Children> & Metadata & { readonly output?: OutputDeclaration<Output, never> }): FactoryDefinition<Kind, Input, Output, ResourcesOf<NoInfer<Requires>>, ResourcesOf<NoInfer<ExceptionRequires>>, never>;
}

/** Inference convenience: factories create the same Scene/Group/Node author objects as constructors. */
function factory<Kind extends CallableKind, Input, Output>(kind: Kind): DefinitionFactory<Kind, Input, Output> {
  const create = <Delta, const Children extends readonly ChildrenOf<Kind>[] = readonly [], const Requires extends ResourceRequests = Readonly<Record<never, never>>, const Uses extends readonly NoInfer<Children[number]>[] | undefined = undefined, const ExceptionRequires extends ResourceRequests = Readonly<Record<never, never>>, const ExceptionUses extends readonly NoInfer<Children[number]>[] = readonly []>(options: DefinitionOptions<Kind, Input, Output, Children, Requires, Uses, ExceptionRequires, ExceptionUses, Delta> & FactoryMembers<Kind, Children> & Metadata & { readonly output?: OutputDeclaration<Output, Delta> }) => {
    if (kind === 'node' && options.members !== undefined) throw new TypeError('Node cannot have members');
    const structure = kind === 'scene' ? new Scene<Input, Output, ResourcesOf<Requires>, ResourcesOf<ExceptionRequires>, Delta>() : kind === 'group' ? new Group<Input, Output, ResourcesOf<Requires>, ResourcesOf<ExceptionRequires>, Delta>() : new Node<Input, Output, ResourcesOf<Requires>, ResourcesOf<ExceptionRequires>, Delta>();
    const members = options.members;
    const definition = {
      name: options.name,
      label: options.label,
      source: options.source,
      callee: options.callee,
      maxRounds: options.maxRounds,
      raises: options.raises,
      observation: options.observation,
      checkpoint: options.checkpoint,
      receptions: options.receptions,
      output: options.output,
      run: options.run,
      exceptions: options.exceptions,
    };
    // The factory has checked the member-relative phase signatures above. The
    // constructor kind selection and the setter's broader position type meet here.
    const callable = structure as unknown as Callable<Input, Output, Kind, Delta>;
    callable.setDefinition(definition as InferredCallableDefinition<Input, Output, Kind, Requires, Uses, ExceptionRequires, ExceptionUses, Delta>);
    if ('add' in structure) structure.add(...(members ?? []));
    return structure as FactoryDefinition<Kind, Input, Output, ResourcesOf<Requires>, ResourcesOf<ExceptionRequires>, Delta>;
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
