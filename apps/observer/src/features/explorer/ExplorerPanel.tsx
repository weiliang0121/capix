import { BrainCircuit } from 'lucide-react';
import { useAppStore, useAppCommands } from '../../state/react';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { errorMessage } from '../../lib/errors';
import { RuntimeExplorer } from './RuntimeExplorer';
export function ExplorerPanel() {
  const conversationId = useAppStore((state) => state.data.activeConversation?.id);
  const observationNotice = useAppStore((state) => state.data.observationNotice);
  const observationError = useAppStore((state) => state.data.observationError);
  const observationLoading = useAppStore((state) => state.data.observationLoading);
  const observationReconnectable = useAppStore((state) => state.data.observationReconnectable);
  const rounds = useAppStore((state) => state.data.rounds);
  const graphs = useAppStore((state) => state.data.graphs);
  const { loadExecution, reconnectObservation } = useAppCommands();
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
      {observationNotice && (
        <p className="observation-notice" role="status">
          {observationNotice}
        </p>
      )}
      {Boolean(observationError) && (
        <div className="observation-notice" role="status">
          <span>
            {observationReconnectable ? '观测连接已中断' : '观测已停止'}：{errorMessage(observationError)}
          </span>
          {observationReconnectable && (
            <Button variant="ghost" size="sm" onClick={() => void reconnectObservation()}>
              重新连接观测
            </Button>
          )}
        </div>
      )}
      {!observationError && observationLoading && (
        <p className="observation-notice" role="status">
          {rounds.length ? '正在重新连接观测，已接收的图谱仍然保留…' : '正在加载观测数据…'}
        </p>
      )}
      <RuntimeExplorer key={conversationId ?? 'initial'} rounds={rounds} graphs={graphs} loadExecution={loadExecution} matches={matches} search={search} setSearch={setSearch} matchCursor={matchCursor} setMatchCursor={setMatchCursor} columnWidth={columnWidth} setColumnWidth={setColumnWidth} selectedId={selectedId} onSelect={select} onInspect={inspect} />
    </section>
  );
}
