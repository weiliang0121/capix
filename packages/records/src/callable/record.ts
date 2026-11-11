import type { CallableRecord as CallableRecordData, CallableValue } from '../data/index.js';
import { InvocationRecord } from '../invocation/record.js';
import { snapshotValue } from '../value/snapshot.js';

export type CallableRecordOptions = Omit<CallableRecordData, 'id' | 'value' | 'status' | 'childIds'>;

/** A real call, with structural description independent from its actual parent relationship. */
export class CallableRecord extends InvocationRecord<CallableValue> implements CallableRecordData {
  override readonly kind = 'invocation' as const;
  readonly contextId: string;
  readonly structureKind: CallableRecordData['structureKind'];
  readonly structureId?: string;
  readonly name?: string;
  readonly label?: string;
  readonly source?: string;
  readonly callee?: string;
  readonly role?: string;

  constructor(options: CallableRecordOptions, value: Omit<CallableValue, 'processes' | 'relationChanges'> & { startedAt: string }) {
    super(snapshotValue({ ...value, processes: [], relationChanges: [] }), options.parentId);
    this.contextId = options.contextId;
    this.structureKind = options.structureKind;
    this.structureId = options.structureId;
    this.name = options.name;
    this.label = options.label;
    this.source = options.source;
    this.callee = options.callee;
    this.role = options.role;
    Object.freeze(this);
  }

  override toJSON(): CallableRecordData {
    return {
      ...super.toJSON(),
      contextId: this.contextId,
      structureKind: this.structureKind,
      status: this.status,
      ...(this.structureId !== undefined ? { structureId: this.structureId } : {}),
      ...(this.name !== undefined ? { name: this.name } : {}),
      ...(this.label !== undefined ? { label: this.label } : {}),
      ...(this.source !== undefined ? { source: this.source } : {}),
      ...(this.callee !== undefined ? { callee: this.callee } : {}),
      ...(this.role !== undefined ? { role: this.role } : {}),
    };
  }
}
