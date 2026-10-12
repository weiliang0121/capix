import type { ObservationStatus } from '../observation/status.js';
import type { RelationChangeRecord } from '@capix/protocol';

export interface CallGraphNode {
  readonly id: string;
  readonly label: string;
  readonly level: 'execution' | 'operation' | 'attempt';
  readonly status: ObservationStatus;
  readonly name?: string;
  readonly summary?: string;
  readonly reception?: { readonly status: RelationChangeRecord['change']['kind']; readonly label: string };
  /** One-based attachment order among this parent's direct children, when all are known. */
  readonly order?: number;
  readonly children: readonly CallGraphNode[];
  readonly durationMs?: number;
  readonly incomplete?: boolean;
}

export interface CallGraphModel {
  readonly roots: readonly CallGraphNode[];
  /** Calls whose ancestry is incomplete; these are not additional execution roots. */
  readonly detached: readonly CallGraphNode[];
  readonly summaryOnly: boolean;
  readonly runtimeId?: string;
  readonly incomplete: boolean;
}
