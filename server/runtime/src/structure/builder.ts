import { types } from 'node:util';
import { CallableBinder, type CallableBindingOptions, type CallableBindings } from '../binding/callable.js';
import type { Resources } from '../resource/resources.js';
import type { CallableCallsOptions } from '../binding/calls.js';
import type { Interactions } from '../interaction/interactions.js';
import type { AnyCallable, ResolvedCallable } from '../binding/declarations.js';
import { BoundChildren } from '../binding/children/bound.js';
import { InvocationWorkBinding } from '../binding/work.js';
import type { CallableContext } from '../context/callable.js';
import type { CallableInput } from '../definition/signature.js';
import { CallableInvocationBuilder } from '../invocation/builders/callable.js';
import { snapshotInvocationCapabilities, type InvocationCapabilities } from '../invocation/capabilities.js';
import { Callable } from './callable.js';
import { assertStructureConfigurable, beginStructureBuild, endStructureBuild, lockStructureConfiguration, structureParent } from './configuration.js';
import { installCallableConstruction, type BuiltCallable, type CallableConstruction } from './construction.js';

/** Prepare the complete tree before committing construction data to the original structures. */
export class CallableBuilder {
  private readonly binder: CallableBinder;
  private readonly capabilities: InvocationCapabilities;

  constructor(capabilities: InvocationCapabilities = {}) {
    this.capabilities = snapshotInvocationCapabilities(capabilities);
    this.binder = new CallableBinder(this.capabilities);
  }

  build<Structure extends AnyCallable, Options, Source>(structure: Structure, options: CallableBindingOptions<NoInfer<CallableInput<Structure>>, Options, Source>): BuiltCallable<Structure, Options> {
    return this.construct(structure, () => this.binder.bind(structure, options));
  }

  buildResources<Structure extends AnyCallable, Options extends object>(structure: Structure, resources: Resources<Options>, interactions?: Interactions, options: CallableCallsOptions<Options> = {}): BuiltCallable<Structure, Options> {
    return this.construct(structure, () => this.binder.bindResources(structure, resources, interactions, options));
  }

  private construct<Structure extends AnyCallable, Options>(structure: Structure, resolve: () => CallableBindings<Structure, Options>): BuiltCallable<Structure, Options> {
    const tree = checkTree(structure);
    const reserved = new Set(tree);
    const original = tree.map((structure) => ({ structure, descriptors: Object.getOwnPropertyDescriptors(structure) }));
    for (const current of tree) beginStructureBuild(current);
    try {
      const { root, calls } = resolve();
      const invocations = new CallableInvocationBuilder(this.capabilities);
      const prepared: { structure: AnyCallable; construction: CallableConstruction; fields: PropertyDescriptorMap }[] = [];
      const prepare = (node: ResolvedCallable): void => {
        if (!reserved.delete(node.definition)) throw new Error('Callable membership changed while building');
        for (const member of node.members) if (structureParent(member.definition) !== node.definition) throw new Error('Callable membership changed while building');
        const children = new BoundChildren(node.members, node.declaration.names);
        const composite = node.declaration.members !== undefined;
        const work = new InvocationWorkBinding<any, any, CallableContext<any, any, object>, object, object, any>(node.declaration, children, composite);
        const binding = Object.freeze({ definition: node.definition, declaration: node.declaration, children, composite, deps: node.deps, supply: node.supply, refinements: node.refinements, work });
        const fields: PropertyDescriptorMap = {};
        for (const [key, value] of Object.entries(node.declaration)) {
          if (key === 'kind' || key === 'members' || key === 'names') continue;
          const existing = Object.getOwnPropertyDescriptor(node.definition, key);
          if (existing && !existing.configurable) throw new Error(`Callable configuration field cannot be fixed: ${key}`);
          fields[key] = { value, enumerable: true, writable: false, configurable: false };
        }
        // Identity and membership cannot be reassigned after construction either.
        for (const key of ['id', 'kind', ...(composite ? ['members', 'names'] : [])]) {
          const existing = Object.getOwnPropertyDescriptor(node.definition, key);
          const value = key === 'id' ? node.definition.id : key === 'kind' ? node.declaration.kind : key === 'members' ? node.declaration.members : node.declaration.names;
          const fixed = existing && 'value' in existing && !existing.writable && existing.value === value;
          if (existing && !existing.configurable && !fixed) throw new Error(`Callable structure field cannot be fixed: ${key}`);
          if (!existing || existing.configurable) fields[key] = { value, enumerable: true, writable: false, configurable: false };
        }
        prepared.push({ structure: node.definition, construction: { binding, calls, invocations }, fields });
        for (const member of node.members) prepare(member);
      };
      prepare(root);
      if (reserved.size) throw new Error('Callable membership changed while building');
      // Host hooks cannot replace interpreted fields between resolution and installation.
      for (const { structure, descriptors } of original) {
        if (!Object.isExtensible(structure)) throw new Error('Callable structure changed while building');
        for (const key of configurationFields) {
          const before = descriptors[key];
          const after = Object.getOwnPropertyDescriptor(structure, key);
          if (!sameDescriptor(before, after)) throw new Error(`Callable configuration changed while building: ${key}`);
        }
      }
      for (const item of prepared) {
        Object.defineProperties(item.structure, item.fields);
        installCallableConstruction(item.structure, item.construction);
        lockStructureConfiguration(item.structure);
      }
      // Construction is authenticated at runtime; this type refinement keeps the very same object.
      return structure as BuiltCallable<Structure, Options>;
    } finally {
      for (const current of tree) endStructureBuild(current);
    }
  }
}

function checkTree(root: AnyCallable): readonly AnyCallable[] {
  const seen = new Set<AnyCallable>();
  const visit = (structure: AnyCallable, parent?: AnyCallable): void => {
    if (types.isProxy(structure)) throw new TypeError('Callable structures cannot be proxies');
    if (!(structure instanceof Callable)) throw new TypeError('Callable structure must be a Scene, Group or Node');
    assertStructureConfigurable(structure);
    if (!Object.isExtensible(structure)) throw new Error('Callable structure must allow construction before build');
    if (structureParent(structure) !== parent) throw new Error('Callable structure has another parent or unregistered membership');
    if (seen.has(structure)) throw new Error('Callable structure occurs more than once');
    seen.add(structure);
    if (structure.kind !== 'node') {
      if (!structure.members) throw new TypeError('Composite structures must provide their members');
      for (const member of structure.members) visit(member, structure);
    }
  };
  visit(root);
  return [...seen];
}

const configurationFields = ['id', 'kind', 'members', 'names', 'name', 'label', 'source', 'callee', 'maxRounds', 'raises', 'output', 'run', 'exceptions', 'observation', 'checkpoint', 'receptions'] as const;

function sameDescriptor(before: PropertyDescriptor | undefined, after: PropertyDescriptor | undefined): boolean {
  if (!before || !after) return before === after;
  return before.value === after.value && before.get === after.get && before.set === after.set && before.writable === after.writable && before.enumerable === after.enumerable && before.configurable === after.configurable;
}
