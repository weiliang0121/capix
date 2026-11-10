import type { ResourceRecord as ResourceRecordData } from '@weiliang0121/capix-protocol';
import { BaseRecord } from '../record.js';
import { snapshotValue } from '../value/snapshot.js';

export type ResourceRecordOptions = Omit<ResourceRecordData, 'id' | 'value'>;

/** Resource-neutral identity and ownership; the access contract supplies a plain detail body. */
export class ResourceRecord<Detail = unknown> extends BaseRecord<Detail> implements ResourceRecordData<Detail> {
  override readonly kind = 'resource' as const;
  override get parentId(): string {
    return super.parentId!;
  }
  readonly access: string;
  readonly supplyId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly phase: ResourceRecordData['phase'];
  readonly interactionId?: string;

  constructor(options: ResourceRecordOptions, detail: Detail) {
    super(snapshotValue(detail), options.parentId);
    this.access = options.access;
    this.supplyId = options.supplyId;
    this.sequence = options.sequence;
    this.occurredAt = options.occurredAt;
    this.phase = options.phase;
    this.interactionId = options.interactionId;
    Object.freeze(this);
  }

  override toJSON(): ResourceRecordData<Detail> {
    return { ...super.toJSON(), parentId: this.parentId, access: this.access, supplyId: this.supplyId, sequence: this.sequence, occurredAt: this.occurredAt, phase: this.phase, ...(this.interactionId ? { interactionId: this.interactionId } : {}) };
  }
}
