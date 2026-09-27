import { BrainCircuit } from 'lucide-react';
import { useAppStore } from '../../state/react';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { RuntimeExplorer } from './RuntimeExplorer';
export function ExplorerPanel() {
  const rounds = useAppStore((state) => state.data.rounds);
  const memoryCount = useAppStore((state) => state.data.memory.items.length);
  const selectedId = useAppStore((state) => state.selectedId);
  const select = useAppStore((state) => state.select);
  const inspect = useAppStore((state) => state.inspect);
  const setMemoryOpen = useAppStore((state) => state.setMemoryOpen);
  const matches = useAppStore((state) => state.matches);
  const search = useAppStore((state) => state.search);
  const setSearch = useAppStore((state) => state.setSearch);
  const matchCursor = useAppStore((state) => state.matchCursor);
  const setMatchCursor = useAppStore((state) => state.setMatchCursor);
  const columnWidth = useAppStore((state) => state.columnWidth);
  const setColumnWidth = useAppStore((state) => state.setColumnWidth);
  return (
    <section className="observer-panel">
      <header className="panel-heading">
        <div>
          <span className="eyebrow">RUNTIME EXPLORER</span>
          <div className="heading-title">
            <h1>运行图谱</h1>
            <Badge variant="secondary">{rounds.length} 轮问答</Badge>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => setMemoryOpen(true)}>
          <BrainCircuit />
          记忆 <span className="button-count">{memoryCount}</span>
        </Button>
      </header>
      <RuntimeExplorer rounds={rounds} matches={matches} search={search} setSearch={setSearch} matchCursor={matchCursor} setMatchCursor={setMatchCursor} columnWidth={columnWidth} setColumnWidth={setColumnWidth} selectedId={selectedId} onSelect={select} onInspect={inspect} />
    </section>
  );
}
