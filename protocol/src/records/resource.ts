import type { BaseRecord } from '../records.js';

/** A runtime fact about one formally published resource access. Detail belongs to the resource contract. */
export interface ResourceFact<Detail = unknown> extends BaseRecord<Detail> {
  readonly parentId: string;
  readonly access: string;
  readonly supplyId: string;
  /** Order within the owning call's resource facts, not an observation cursor. */
  readonly sequence: number;
  readonly occurredAt: string;
  readonly phase: 'bound' | 'available' | 'unavailable' | 'started' | 'returned' | 'threw';
  readonly interactionId?: string;
}
