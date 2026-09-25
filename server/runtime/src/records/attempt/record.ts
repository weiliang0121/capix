import { pick } from 'es-toolkit/object';
import type { AttemptRecord as AttemptData, AttemptValue } from '@capix-observer/protocol';
import { InvocationRecord } from '../invocation/record.js';
import { snapshotValue } from '../value/snapshot.js';

export type AttemptDefinition = Omit<AttemptData, 'id' | 'value' | 'status'>;

/** Records one named action invocation. Its owner supplies execution and operation instance identity. */
export class AttemptRecord extends InvocationRecord<AttemptValue> implements AttemptData {
  readonly contextId: string;
  readonly operationId: string;
  readonly name: string;
  readonly label: string;
  readonly source: string;
  readonly caller: string;
  readonly callee: string;

  constructor(definition: AttemptDefinition, input: unknown) {
    super(snapshotValue({ input, processes: [] }));
    this.contextId = definition.contextId;
    this.operationId = definition.operationId;
    this.name = definition.name;
    this.label = definition.label;
    this.source = definition.source;
    this.caller = definition.caller;
    this.callee = definition.callee;
    Object.freeze(this);
  }

  override toJSON(): AttemptData {
    return {
      ...super.toJSON(),
      status: this.status,
      ...pick(this, ['contextId', 'operationId', 'name', 'label', 'source', 'caller', 'callee']),
    };
  }
}
