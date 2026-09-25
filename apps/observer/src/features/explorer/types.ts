import type { ObserverOverview } from '@capix-observer/protocol';
export interface ExplorerProps {
  overview: ObserverOverview;
  selectedId: string;
  onSelect: (id: string) => void;
  onInspect: (executionId: string, callId?: string) => void;
}
