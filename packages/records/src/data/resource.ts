import type { BaseRecord } from './types.js';

/** Serialized resource access record produced by the optional recording preset; not a live ResourceObservation. */
export interface ResourceRecord<Detail = unknown> extends BaseRecord<Detail> {
  readonly parentId: string;
  readonly access: string;
  readonly supplyId: string;
  /** Strictly increasing within the owning call's resource observations and domain facts.
   * Domain facts are projected separately, so resource records may have gaps; not a transport cursor.
   */
  readonly sequence: number;
  readonly occurredAt: string;
  readonly phase: 'bound' | 'available' | 'unavailable' | 'started' | 'returned' | 'threw';
  readonly interactionId?: string;
}
