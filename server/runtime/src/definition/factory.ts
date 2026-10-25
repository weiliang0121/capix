import type { CallableKind } from '@capix/protocol';
import type { OutputDeclaration } from '../output/contract.js';
import type { ChildrenOf } from './children.js';
import type { InvocationCheckpointDefinition } from './checkpoint.js';
import type { ResourceRequests, ResourcesOf } from '../resource/offer.js';
import type { CallableWork } from './work.js';
import { Scene } from '../structure/scene.js';
import { Group } from '../structure/group.js';
import { Node } from '../structure/node.js';
import type { CallableDefinition } from './callable.js';
import type { ReceptionRegistration } from './reception.js';

type FactoryMembers<Kind extends CallableKind, Children extends readonly ChildrenOf<Kind>[]> = Kind extends 'node' ? { readonly members?: never } : { readonly members?: Children };
interface DefinitionOptions<Kind extends CallableKind, Input, Output, Children extends readonly ChildrenOf<Kind>[], Deps extends ResourceRequests, Delta> {
  readonly name?: string;
  readonly label?: string;
  readonly source?: string;
  readonly checkpoint?: Omit<InvocationCheckpointDefinition<Input, Output, Kind, NoInfer<Delta>>, 'receptions'> & { readonly receptions?: Kind extends 'node' ? never : readonly ReceptionRegistration<NoInfer<Children[number]>>[] };
  readonly deps?: Deps;
  readonly run: (work: CallableWork<Kind, Input, Output, ResourcesOf<NoInfer<Deps>>, Children[number], Delta>) => Output | Promise<Output>;
}

type FactoryDefinition<Kind extends CallableKind, Input, Output, Resources extends object, Delta> = Kind extends 'scene' ? Scene<Input, Output, Resources, Delta> : Kind extends 'group' ? Group<Input, Output, Resources, Delta> : Node<Input, Output, Resources, Delta>;

export interface DefinitionFactory<Kind extends CallableKind, Input, Output> {
  <Delta, const Children extends readonly ChildrenOf<Kind>[] = readonly [], const Deps extends ResourceRequests = Readonly<Record<never, never>>>(options: DefinitionOptions<Kind, Input, Output, Children, Deps, NoInfer<Delta>> & FactoryMembers<Kind, Children> & { readonly output: OutputDeclaration<Output, Delta> & { readonly delta: (value: unknown) => Delta } }): FactoryDefinition<Kind, Input, Output, ResourcesOf<NoInfer<Deps>>, Delta>;
  <const Children extends readonly ChildrenOf<Kind>[] = readonly [], const Deps extends ResourceRequests = Readonly<Record<never, never>>>(options: DefinitionOptions<Kind, Input, Output, Children, Deps, never> & FactoryMembers<Kind, Children> & { readonly output?: OutputDeclaration<Output, never> }): FactoryDefinition<Kind, Input, Output, ResourcesOf<NoInfer<Deps>>, never>;
}

/** Inference convenience over the same constructor configuration and member registration. */
function factory<Kind extends CallableKind, Input, Output>(kind: Kind): DefinitionFactory<Kind, Input, Output> {
  const create = <Delta, const Children extends readonly ChildrenOf<Kind>[] = readonly [], const Deps extends ResourceRequests = Readonly<Record<never, never>>>(options: DefinitionOptions<Kind, Input, Output, Children, Deps, Delta> & FactoryMembers<Kind, Children> & { readonly output?: OutputDeclaration<Output, Delta> }) => {
    if (kind === 'node' && options.members !== undefined) throw new TypeError('Node cannot have members');
    const members = options.members;
    for (const field of ['setRun', 'setDefinition', 'accept', 'exceptions', 'raises', 'maxRounds', 'uses', 'observation', 'callee', 'receptions']) {
      if (field in options) throw new TypeError(`Unsupported callable configuration field: ${field}`);
    }
    const configuration = { name: options.name, label: options.label, source: options.source, deps: options.deps, run: options.run, output: options.output, checkpoint: options.checkpoint };
    // The factory narrows callable members by registration; the constructor has
    // the whole kind's legal contract. Both refer to the same runtime objects.
    const definition = { ...configuration, run: options.run.bind(options) } as CallableDefinition<Input, Output, Kind, ResourcesOf<Deps>, Delta>;
    const structure = kind === 'scene' ? new Scene<Input, Output, ResourcesOf<Deps>, Delta>(definition as CallableDefinition<Input, Output, 'scene', ResourcesOf<Deps>, Delta>) : kind === 'group' ? new Group<Input, Output, ResourcesOf<Deps>, Delta>(definition as CallableDefinition<Input, Output, 'group', ResourcesOf<Deps>, Delta>) : new Node<Input, Output, ResourcesOf<Deps>, Delta>(definition as CallableDefinition<Input, Output, 'node', ResourcesOf<Deps>, Delta>);
    if ('add' in structure) structure.add(...(members ?? []));
    return structure as FactoryDefinition<Kind, Input, Output, ResourcesOf<Deps>, Delta>;
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
