import { useEffect, useState } from 'react';
import { BrainCircuit } from 'lucide-react';
import { useAppStore, useClientRuntime, useClientState, useExecutionSnapshot } from '../state/react';
import { errorMessage } from '../state/store';
import { RuntimeExplorer } from '../features/explorer/RuntimeExplorer';
import { InspectionDialog, MemoryDialog } from './details';
import { Button } from './ui/button';
import { Badge } from './ui/badge';

export function ExplorerPanel() {
  const overview = useClientState((state) => state.overview);
  const memoryCount = useClientState((state) => state.memory.items.length);
  const selectedId = useAppStore((state) => state.selectedId);
  const select = useAppStore((state) => state.select);
  const inspect = useAppStore((state) => state.inspect);
  const setMemoryOpen = useAppStore((state) => state.setMemoryOpen);
  return (
    <section className="observer-panel">
      <header className="panel-heading">
        <div>
          <span className="eyebrow">RUNTIME EXPLORER</span>
          <div className="heading-title">
            <h1>运行图谱</h1>
            <Badge variant="secondary">{overview.executions.length} 轮问答</Badge>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => setMemoryOpen(true)}>
          <BrainCircuit />
          记忆 <span className="button-count">{memoryCount}</span>
        </Button>
      </header>
      <RuntimeExplorer overview={overview} selectedId={selectedId} onSelect={select} onInspect={inspect} />
    </section>
  );
}

export function ObservationDialogs() {
  const overview = useClientState((state) => state.overview);
  const memory = useClientState((state) => state.memory);
  const inspection = useAppStore((state) => state.inspection);
  const memoryOpen = useAppStore((state) => state.memoryOpen);
  const setMemoryOpen = useAppStore((state) => state.setMemoryOpen);
  const inspect = useAppStore((state) => state.inspect);
  const closeInspection = useAppStore((state) => state.closeInspection);
  const runtime = useClientRuntime();
  const snapshot = useExecutionSnapshot(inspection?.executionId);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  useEffect(() => {
    if (!inspection) return;
    const controller = new AbortController();
    const cached = runtime.getExecution(inspection.executionId);
    setDetailError('');
    if (cached && cached.execution.status !== 'running') {
      setDetailLoading(false);
      return;
    }
    setDetailLoading(!cached);
    runtime
      .loadExecution(inspection.executionId, controller.signal)
      .catch((error) => {
        if (!controller.signal.aborted) setDetailError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [runtime, inspection?.executionId]);
  return (
    <>
      <MemoryDialog open={memoryOpen} onOpenChange={setMemoryOpen} memory={memory} onInspect={inspect} />
      <InspectionDialog runtime={runtime} target={inspection} snapshot={snapshot} loading={detailLoading} error={detailError} overview={overview} memory={memory} onClose={closeInspection} onInspect={inspect} />
    </>
  );
}
