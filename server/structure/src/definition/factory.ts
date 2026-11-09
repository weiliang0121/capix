import type { CallableKind } from '@weiliang0121/capix-contracts';
import type { OutputDeclaration } from '@weiliang0121/capix-contracts';
import type { ChildrenOf } from './children.js';
import type { InvocationCheckpointDefinition } from './checkpoint.js';
import { ResourceRequest, type ResourceRequests, type ResourcesOf } from '@weiliang0121/capix-resources';
import type { CallableWork } from './work.js';
import { Scene } from '../scene.js';
import { Group } from '../group.js';
import { Node } from '../node.js';
import type { CallableDefinition } from './callable.js';
import type { ReceptionRegistration } from '@weiliang0121/capix-contracts';

type EmptyDependencies = Readonly<Record<never, never>>;
type LocalDependencies<Common extends ResourceRequests, Deps extends ResourceRequests> = Deps & { readonly [Name in keyof Common]?: never };

type FactoryMembers<Kind extends CallableKind, Children extends readonly ChildrenOf<Kind>[]> = Kind extends 'node' ? { readonly members?: never } : { readonly members?: Children };
interface DefinitionOptions<Kind extends CallableKind, Input, Output, Children extends readonly ChildrenOf<Kind>[], Deps extends ResourceRequests, Delta, Common extends ResourceRequests = EmptyDependencies> {
  readonly name?: string;
  readonly label?: string;
  readonly source?: string;
  readonly checkpoint?: Omit<InvocationCheckpointDefinition<Input, Output, Kind, NoInfer<Delta>>, 'receptions'> & { readonly receptions?: Kind extends 'node' ? never : readonly ReceptionRegistration<NoInfer<Children[number]>>[] };
  readonly deps?: LocalDependencies<Common, Deps>;
  readonly run: (work: CallableWork<Kind, Input, Output, ResourcesOf<NoInfer<Common & Deps>>, Children[number], Delta>) => Output | Promise<Output>;
}

type FactoryDefinition<Kind extends CallableKind, Input, Output, Resources extends object, Delta> = Kind extends 'scene' ? Scene<Input, Output, Resources, Delta> : Kind extends 'group' ? Group<Input, Output, Resources, Delta> : Node<Input, Output, Resources, Delta>;

interface DefinitionFactory<Kind extends CallableKind, Input, Output, Common extends ResourceRequests = EmptyDependencies> {
  <Delta, const Children extends readonly ChildrenOf<Kind>[] = readonly [], const Deps extends ResourceRequests = Readonly<Record<never, never>>>(options: DefinitionOptions<Kind, Input, Output, Children, Deps, NoInfer<Delta>, Common> & FactoryMembers<Kind, Children> & { readonly output: OutputDeclaration<Output, Delta> & { readonly delta: (value: unknown) => Delta } }): FactoryDefinition<Kind, Input, Output, ResourcesOf<NoInfer<Common & Deps>>, Delta>;
  <const Children extends readonly ChildrenOf<Kind>[] = readonly [], const Deps extends ResourceRequests = Readonly<Record<never, never>>>(options: DefinitionOptions<Kind, Input, Output, Children, Deps, never, Common> & FactoryMembers<Kind, Children> & { readonly output?: OutputDeclaration<Output, never> }): FactoryDefinition<Kind, Input, Output, ResourcesOf<NoInfer<Common & Deps>>, never>;
}

/** Inference convenience over the same constructor configuration and member registration. */
function factory<Kind extends CallableKind, Input, Output, Common extends ResourceRequests = EmptyDependencies>(kind: Kind, common?: Common): DefinitionFactory<Kind, Input, Output, Common> {
  const create = <Delta, const Children extends readonly ChildrenOf<Kind>[] = readonly [], const Deps extends ResourceRequests = Readonly<Record<never, never>>>(options: DefinitionOptions<Kind, Input, Output, Children, Deps, Delta, Common> & FactoryMembers<Kind, Children> & { readonly output?: OutputDeclaration<Output, Delta> }) => {
    if (kind === 'node' && options.members !== undefined) throw new TypeError('Node cannot have members');
    const members = options.members;
    for (const field of ['setRun', 'setDefinition', 'accept', 'exceptions', 'raises', 'maxRounds', 'uses', 'observation', 'callee', 'receptions']) {
      if (field in options) throw new TypeError(`Unsupported callable configuration field: ${field}`);
    }
    for (const name of Object.keys(common ?? {})) if (Object.hasOwn(options.deps ?? {}, name)) throw new Error(`Duplicate common dependency alias: ${name}`);
    const deps = common ? Object.freeze({ ...common, ...options.deps }) : options.deps;
    const configuration = { name: options.name, label: options.label, source: options.source, deps, run: options.run, output: options.output, checkpoint: options.checkpoint };
    // The factory narrows callable members by registration; the constructor has
    // the whole kind's legal contract. Both refer to the same runtime objects.
    const definition = { ...configuration, run: options.run.bind(options) } as CallableDefinition<Input, Output, Kind, ResourcesOf<Common & Deps>, Delta>;
    const structure = kind === 'scene' ? new Scene<Input, Output, ResourcesOf<Common & Deps>, Delta>(definition as CallableDefinition<Input, Output, 'scene', ResourcesOf<Common & Deps>, Delta>) : kind === 'group' ? new Group<Input, Output, ResourcesOf<Common & Deps>, Delta>(definition as CallableDefinition<Input, Output, 'group', ResourcesOf<Common & Deps>, Delta>) : new Node<Input, Output, ResourcesOf<Common & Deps>, Delta>(definition as CallableDefinition<Input, Output, 'node', ResourcesOf<Common & Deps>, Delta>);
    if ('add' in structure) structure.add(...(members ?? []));
    return structure as FactoryDefinition<Kind, Input, Output, ResourcesOf<Common & Deps>, Delta>;
  };
  return create as DefinitionFactory<Kind, Input, Output, Common>;
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

/** Common requests are fixed before authoring run; supply still belongs to Resources. */
export function withDependencies<const Common extends ResourceRequests>(dependencies: Common) {
  const common = Object.freeze({ ...dependencies });
  for (const request of Object.values(common)) if (!(request instanceof ResourceRequest)) throw new TypeError('Common dependencies must be resource requests');
  return Object.freeze({
    node<Input, Output>(): DefinitionFactory<'node', Input, Output, Common> {
      return factory<'node', Input, Output, Common>('node', common);
    },
    group<Input, Output>(): DefinitionFactory<'group', Input, Output, Common> {
      return factory<'group', Input, Output, Common>('group', common);
    },
    scene<Input, Output>(): DefinitionFactory<'scene', Input, Output, Common> {
      return factory<'scene', Input, Output, Common>('scene', common);
    },
  });
}
