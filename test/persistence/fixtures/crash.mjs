import { SqliteObserverStore, initializeObserver } from '@capix/observer-service';
import { Transcript } from '@capix/transcript';
import { Memories } from '@capix/memory';

const mode = process.argv[2];
const store = SqliteObserverStore.open(process.argv[3]);
if (mode === 'content') {
  const transcript = new Transcript();
  const memories = new Memories(transcript);
  store.initialize({ transcript: transcript.exportState(), memories: memories.exportState() });
  const restored = Transcript.restore(transcript.exportState(), {
    persistence: {
      commit(change) {
        store.transcript.commit(change);
        process.kill(process.pid, 'SIGKILL');
      },
    },
  });
  restored.append({ role: 'user', content: 'durable before memory application' });
} else {
  let executionId;
  const save = store.applyRecordChange.bind(store);
  store.applyRecordChange = (event) => {
    save(event);
    if (event.change.kind === 'added' && event.change.entry.kind === 'invocation' && event.change.entry.data.role === 'conversation-task') executionId = event.change.entry.data.id;
    if (mode === 'finished' && event.change.kind === 'finished' && event.change.id === executionId) process.kill(process.pid, 'SIGKILL');
  };
  const environment = initializeObserver(
    {
      async invoke(_request, purpose) {
        if (mode === 'running') process.kill(process.pid, 'SIGKILL');
        return { id: 'fixture', model: 'fixture', content: JSON.stringify(purpose === 'selection' ? { historyIndexes: [] } : purpose === 'answer' ? { kind: 'answer', content: 'durable answer' } : { memories: [] }), finishReason: 'stop', usage: null };
      },
    },
    [],
    { persistence: store },
  );
  await environment.runner.run({ messages: [{ role: 'user', content: 'crash window' }] }, { settings: { model: 'fixture', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 1000 } });
}
throw new Error('Crash checkpoint was not reached');
