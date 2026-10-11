import type { RoundView, SearchMatch } from '../../state/data.js';
import type { CallGraphModel } from '../../state/graph.js';
export interface ExplorerProps {
  rounds: readonly RoundView[];
  graphs: ReadonlyMap<string, CallGraphModel>;
  loadExecution: (id: string, signal?: AbortSignal) => Promise<void>;
  matches: readonly SearchMatch[];
  selectedId: string;
  search: string;
  setSearch: (text: string) => void;
  matchCursor: number;
  setMatchCursor: (index: number) => void;
  columnWidth: number;
  setColumnWidth: (width: number) => void;
  onSelect: (id: string) => void;
  onInspect: (executionId: string, callId?: string) => void;
}
