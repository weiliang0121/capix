// Deterministic transports only: no service, user content or model requests.
import { createRoot } from 'react-dom/client';
import { ClientRuntime, ObservationConnectionError, type ConversationTransport, type TranscriptTransport, type ObservationTransport } from '@capix/client-runtime';
import type { InteractionObservation, ObserverOverview, TranscriptSnapshot } from '@weiliang0121/capix-protocol';
import { createApplication } from '../src/binding/application';
import { AppProvider } from '../src/state/react';
import { ExplorerPanel } from '../src/features/explorer/ExplorerPanel';
import { InteractionDetails } from '../src/features/inspection/InteractionDetails';
import type { CallDetail } from '../src/state/data';
import '../src/styles.css';
import '../src/features/inspection/inspection.css';

const descriptor = { id: 'fixture-conversation', title: '观测检查', transcriptId: 'fixture-transcript', createdAt: 1, updatedAt: 1 };
const transcript: TranscriptSnapshot = { id: descriptor.transcriptId, revision: 0, start: 0, end: 0, starts: [0], messages: [] };
const unexpected = async (): Promise<never> => {
  throw new Error('This fixture never posts or reads a service.');
};
const conversation: ConversationTransport = {
  conversations: async () => ({ conversations: [descriptor], defaultConversationId: descriptor.id }),
  conversation: async () => descriptor,
  activeSubmission: async () => ({ conversationId: descriptor.id, transcriptId: descriptor.transcriptId }),
  createConversation: unexpected,
  config: async () => ({ configured: true, model: 'fixture-model', contextBudget: 4096, maxOutputTokens: 1024, timeoutMs: 10000 }),
  admission: unexpected,
  read: unexpected,
  cancel: unexpected,
  submit: unexpected,
  follow: unexpected,
};
const transcripts: TranscriptTransport = {
  transcript: async () => transcript,
  observeTranscript: async (_id, accept, signal) => {
    accept({ type: 'baseline', snapshot: transcript });
    if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  },
};
const overview: ObserverOverview = { transcriptId: transcript.id, messages: [], executions: [] };
let connections = 0;
let rejectObservation: (error: unknown) => void = () => {
  throw new Error('observation is not connected');
};
let completeInteraction: () => void = () => {
  throw new Error('interaction is not connected');
};
let interactionReads = 0;
const pending: InteractionObservation = { id: 'fixture-interaction', contract: 'observer.model.v1', revision: 1, delivery: 'started', retained: 'persistent', model: 'fixture-model', purpose: 'answer', result: { kind: 'pending' } };
const observation: ObservationTransport = {
  overview: async () => overview,
  memory: async () => ({ items: [] }),
  source: unexpected,
  execution: unexpected,
  observe: async (_id, accept, signal) => {
    connections++;
    accept({ type: 'baseline', scopeId: 'fixture-scope', sequence: 0, overview, memory: { items: [] }, transcript: { id: transcript.id, revision: 0, starts: [0] }, memories: { id: 'fixture-memories', sequence: 0 }, recorder: { id: 'fixture-recorder', revision: 0 }, entries: [], invocations: [] });
    await new Promise<void>((resolve, reject) => {
      rejectObservation = reject;
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
  },
  interactions: async (_conversationId, callId) => ({ callId, interactionIds: [pending.id] }),
  observeInteraction: async (_conversationId, _callId, _id, accept, signal) => {
    interactionReads++;
    accept(pending);
    await new Promise<void>((resolve) => {
      completeInteraction = () => {
        accept({ ...pending, revision: 2, result: { kind: 'received', feedbackId: 'fixture-feedback' } });
        resolve();
      };
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
  },
};
const call: CallDetail = { id: 'fixture-call', contextId: 'fixture-context', recordType: 'node', caller: 'group', callee: 'node', status: 'passed', source: '', label: '调用模型', offsetMs: 0, processes: [], processEntries: [], relationEntries: [], children: [], memory: { incoming: [], changes: [] }, resources: [{ id: 'resource', parentId: 'fixture-call', access: 'model-interaction.read', supplyId: 'supply', sequence: 1, occurredAt: '2026-10-13T00:00:00Z', phase: 'returned', value: null }], localRounds: 1, output: { kind: 'pending', interaction: { id: pending.id } } };
const parent: CallDetail = { ...call, id: 'fixture-parent', relationEntries: [{ childId: call.id, identity: { parentContextId: 'parent-context', childContextId: call.contextId, parentRound: 1 }, eventSequence: 1, occurredAt: '2026-10-13T00:00:00Z', offsetMs: 0, change: { kind: 'accepted', output: call.output } }] };
const runtime = new ClientRuntime({ conversation, transcripts, observation });
const application = createApplication(runtime);
const host = document.getElementById('root')!;
const root = createRoot(host);
const results: string[] = [];
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function waitFor(condition: () => unknown, message: string) {
  const deadline = Date.now() + 3000;
  while (!condition() && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert(condition(), message);
}
async function check(name: string, run: () => Promise<void>) {
  await run();
  results.push(`PASS ${name}`);
  document.getElementById('results')!.textContent = results.join('\n');
}
const reconnect = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('重新连接观测'));
try {
  await runtime.initialize();
  root.render(
    <AppProvider application={application}>
      <main style={{ display: 'grid', gridTemplateColumns: 'minmax(400px, 1fr) 420px', gap: 24, height: 600, margin: 24 }}>
        <ExplorerPanel />
        <aside>
          <InteractionDetails call={call} parent={parent} />
        </aside>
      </main>
    </AppProvider>,
  );
  await check('completed local wait can coexist with an external pending exchange and accepted parent return', async () => {
    await waitFor(() => host.textContent?.includes('父层已接纳本次返回'), 'parent receipt should be visible');
    assert(host.textContent?.includes('发送已登记，等待外部反馈'), 'pending external state');
    assert(host.textContent?.includes('本次等待已结束'), 'local wait ended separately');
    assert(interactionReads === 1, 'one selected detail subscription');
  });
  await check('network failure exposes a working observation reconnect button without restarting the interaction', async () => {
    rejectObservation(new ObservationConnectionError('本地模拟连接中断'));
    await waitFor(() => reconnect(), 'reconnect button visible');
    reconnect()!.click();
    await waitFor(() => connections === 2 && !reconnect(), 'fresh baseline replaces the interrupted connection');
    assert(interactionReads === 1, 'record feed reconnection does not restart independent interaction subscription');
  });
  await check('late feedback updates the card after the call has already returned', async () => {
    completeInteraction();
    await waitFor(() => host.textContent?.includes('反馈已接收并保存'), 'late committed feedback visible');
    assert(host.textContent?.includes('本次等待已结束'), 'local result remains historical');
    assert(host.textContent?.includes('父层已接纳本次返回'), 'parent receipt remains its own fact');
  });
  await check('source incompleteness shows a terminal observation notice without a misleading reconnect action', async () => {
    rejectObservation(Object.assign(new Error('本地模拟来源不完整'), { code: 'SOURCE_INCOMPLETE' }));
    await waitFor(() => host.textContent?.includes('观测已停止'), 'terminal notice visible');
    assert(!reconnect(), 'no reconnect for incomplete facts');
    assert(host.textContent?.includes('反馈已接收并保存'), 'independent interaction detail remains readable');
  });
  document.getElementById('results')!.dataset.status = 'passed';
} catch (error) {
  document.getElementById('results')!.textContent = `${results.join('\n')}\nFAIL ${error instanceof Error ? error.stack : String(error)}`;
  document.getElementById('results')!.dataset.status = 'failed';
}
