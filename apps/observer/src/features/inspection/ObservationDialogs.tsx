import { useEffect, useState } from 'react';
import { useAppStore, useAppCommands } from '../../state/react';
import { errorMessage } from '../../lib/errors';
import { InspectionDialog } from './InspectionDialog';
import { MemoryDialog } from '../memory/MemoryDialog';
export function ObservationDialogs() {
  const rounds = useAppStore((state) => state.data.rounds);
  const memory = useAppStore((state) => state.data.memory);
  const inspection = useAppStore((state) => state.inspection);
  const memoryOpen = useAppStore((state) => state.memoryOpen);
  const setMemoryOpen = useAppStore((state) => state.setMemoryOpen);
  const inspect = useAppStore((state) => state.inspect);
  const closeInspection = useAppStore((state) => state.closeInspection);
  const { loadExecution, loadTranscript } = useAppCommands();
  const detail = useAppStore((state) => (inspection ? state.data.details.get(inspection.executionId) : undefined));
  const number = rounds.findIndex((round) => round.id === inspection?.executionId) + 1;
  const qa = rounds[number - 1];
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  useEffect(() => {
    if (!inspection) return;
    const controller = new AbortController();
    const cached = detail;
    setDetailError('');
    if (cached && cached.status !== 'running') {
      setDetailLoading(false);
      return;
    }
    setDetailLoading(!cached);
    loadExecution(inspection.executionId, controller.signal)
      .catch((error) => {
        if (!controller.signal.aborted) setDetailError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [loadExecution, inspection?.executionId]);
  useEffect(() => {
    if (!inspection || !qa?.transcriptId || qa.messagesLoaded) return;
    let active = true;
    void loadTranscript(qa.transcriptId).catch((error) => {
      if (active) setDetailError(errorMessage(error));
    });
    return () => {
      active = false;
    };
  }, [inspection?.executionId, qa?.transcriptId, qa?.messagesLoaded, loadTranscript]);
  return (
    <>
      <MemoryDialog
        onLoadTranscript={(id) => {
          void loadTranscript(id).catch(() => undefined);
        }}
        open={memoryOpen}
        onOpenChange={setMemoryOpen}
        memory={memory}
        onInspect={inspect}
      />
      <InspectionDialog target={inspection} detail={detail} loading={detailLoading} error={detailError} qa={qa} number={number} onClose={closeInspection} onInspect={inspect} />
    </>
  );
}
