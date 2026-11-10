import { pick } from 'es-toolkit/object';
import type { AttemptRecord as AttemptData, AttemptValue } from '@weiliang0121/capix-protocol';
import { InvocationRecord } from '../invocation/record.js';
import { snapshotValue } from '../value/snapshot.js';

export type AttemptRecordOptions = Omit<AttemptData, 'id' | 'value' | 'status' | 'parentId' | 'childIds'>;

/** Records one named action invocation. operationId identifies its parent operation record. */
export class AttemptRecord extends InvocationRecord<AttemptValue> implements AttemptData {
  override readonly kind = 'attempt' as const;
  readonly contextId: string;
  readonly operationId: string;
  readonly name: string;
  readonly label: string;
  readonly source: string;
  readonly caller: string;
  readonly callee: string;

  constructor(options: AttemptRecordOptions, input: unknown) {
    super(snapshotValue({ input, processes: [], relationChanges: [] }), options.operationId);
    this.contextId = options.contextId;
    this.operationId = options.operationId;
    this.name = options.name;
    this.label = options.label;
    this.source = options.source;
    this.caller = options.caller;
    this.callee = options.callee;
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
