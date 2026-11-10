import type { BaseRecord } from './types.js';

/** Serialized resource access record produced by the optional recording preset; not a live ResourceObservation. */
export interface ResourceRecord<Detail = unknown> extends BaseRecord<Detail> {
  readonly parentId: string;
  readonly access: string;
  readonly supplyId: string;
  /** Order within the owning call's resource facts, not an observation cursor. */
  readonly sequence: number;
  readonly occurredAt: string;
  readonly phase: 'bound' | 'available' | 'unavailable' | 'started' | 'returned' | 'threw';
  readonly interactionId?: string;
}
