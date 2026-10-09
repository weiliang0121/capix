import type { ResourceFact } from '@capix-observer/protocol';
import { BaseRecord } from '../record.js';
import { snapshotValue } from '../value/snapshot.js';

export type ResourceFactDefinition = Omit<ResourceFact, 'id' | 'value'>;

/** Resource-neutral identity and ownership; the access contract supplies a plain detail body. */
export class ResourceRecord<Detail = unknown> extends BaseRecord<Detail> implements ResourceFact<Detail> {
  override readonly kind = 'resource' as const;
  override get parentId(): string {
    return super.parentId!;
  }
  readonly access: string;
  readonly supplyId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly phase: ResourceFact['phase'];
  readonly interactionId?: string;

  constructor(definition: ResourceFactDefinition, detail: Detail) {
    super(snapshotValue(detail), definition.parentId);
    this.access = definition.access;
    this.supplyId = definition.supplyId;
    this.sequence = definition.sequence;
    this.occurredAt = definition.occurredAt;
    this.phase = definition.phase;
    this.interactionId = definition.interactionId;
    Object.freeze(this);
  }

  override toJSON(): ResourceFact<Detail> {
    return { ...super.toJSON(), parentId: this.parentId, access: this.access, supplyId: this.supplyId, sequence: this.sequence, occurredAt: this.occurredAt, phase: this.phase, ...(this.interactionId ? { interactionId: this.interactionId } : {}) };
  }
}
