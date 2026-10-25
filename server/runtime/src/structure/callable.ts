import { randomUUID } from 'node:crypto';
import type { CallableKind } from '@capix/protocol';
import { initializeStructureConfiguration } from './configuration.js';
import type { CallableDescription, CallableDefinition, CallableRun, EmptyResources } from '../definition/callable.js';
import type { ChildContractsOf } from '../definition/children.js';
import type { invocationSignature, InvocationSignature } from '../definition/signature.js';
import type { ResourceRequirements } from '../resource/bindings.js';

/** Heterogeneous storage erases I/O and resources; author objects retain them. */
export type CallableStructure<Kind extends CallableKind> = Callable<any, any, Kind, any, any>;

/** Stable structural identity and configuration. Invocation owns all per-call state. */
export abstract class Callable<Input, Output, Kind extends CallableKind, Resources extends object = EmptyResources, Delta = never> {
  readonly id = randomUUID();
  readonly kind: Kind;
  declare readonly [invocationSignature]: InvocationSignature<Input, Output, Delta>;
  name?: string;
  label?: string;
  source?: string;
  deps?: ResourceRequirements<Resources>;
  run?: CallableRun<Input, Output, Kind, Resources, ChildContractsOf<Kind>, Delta, this>;
  output?: CallableDescription<Input, Output, Kind, Delta>['output'];
  checkpoint?: CallableDescription<Input, Output, Kind, Delta>['checkpoint'];

  protected constructor(kind: Kind, configuration?: CallableDefinition<Input, Output, Kind, Resources, Delta>) {
    initializeStructureConfiguration(this);
    if (configuration !== undefined && (!configuration || typeof configuration !== 'object')) throw new TypeError('Callable configuration must be an object');
    for (const field of ['kind', 'members', 'setRun', 'setDefinition', 'accept', 'exceptions', 'raises', 'maxRounds', 'uses', 'observation', 'callee', 'receptions']) {
      if (configuration && field in configuration) throw new TypeError(`Unsupported callable configuration field: ${field}`);
    }
    this.kind = kind;
    this.name = configuration?.name;
    this.label = configuration?.label;
    this.source = configuration?.source;
    this.deps = configuration?.deps;
    this.run = configuration?.run?.bind(configuration);
    this.output = configuration?.output;
    this.checkpoint = configuration?.checkpoint;
    Object.defineProperty(this, 'id', { value: this.id, enumerable: true, writable: false, configurable: false });
    Object.defineProperty(this, 'kind', { value: kind, enumerable: true, writable: false, configurable: false });
  }
}
