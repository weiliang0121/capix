// Local content only: exercises the actual runtime, binding, dialogs and React lifecycle.
import { createRoot } from 'react-dom/client';
import { ClientRuntime, type ConversationTransport, type TranscriptTransport, type ObservationTransport } from '@capix/client-runtime';
import type { ConversationDescriptor, TranscriptSnapshot, Message, ObserverOverview } from '@weiliang0121/capix-protocol';
import { createApplication } from '../src/binding/application';
import { AppProvider } from '../src/state/react';
import { ConversationPanel } from '../src/features/conversation/ConversationPanel';
import { SettingsDialog } from '../src/features/settings/SettingsDialog';
import { ExplorerPanel } from '../src/features/explorer/ExplorerPanel';
import '../src/styles.css';

const initial: ConversationDescriptor = { id: 'initial', title: '北京旅行计划', transcriptId: 'initial-messages', createdAt: 1, updatedAt: 2 };
const other: ConversationDescriptor = { id: 'other', title: '文物与玉器', transcriptId: 'other-messages', createdAt: 3, updatedAt: 4 };
const conversations = new Map([
  [initial.id, initial],
  [other.id, other],
]);
const transcripts = new Map<string, TranscriptSnapshot>();
function snapshot(conversation: ConversationDescriptor, messages: Message[]) {
  transcripts.set(conversation.transcriptId, { id: conversation.transcriptId, revision: messages.length, start: 0, end: messages.length, starts: [0], messages });
}
snapshot(initial, [
  { role: 'user', content: '秋天去香山怎么样？' },
  { role: 'assistant', content: '可以结合天气和红叶情况安排一天的行程。' },
]);
snapshot(other, [
  { role: 'user', content: '玉器分哪些类型？' },
  { role: 'assistant', content: '可以从时代、用途、形制和材质几个角度了解。' },
]);
const unexpected = async (): Promise<never> => {
  throw new Error('This fixture does not submit or call a model.');
};
const conversation: ConversationTransport = {
  conversations: async () => ({ conversations: [...conversations.values()], defaultConversationId: initial.id }),
  conversation: async (id) => {
    const value = conversations.get(id);
    if (!value) throw new Error('Conversation not found');
    return value;
  },
  activeSubmission: async (id) => ({ conversationId: id, transcriptId: conversations.get(id)!.transcriptId }),
  createConversation: async () => {
    const created = { id: 'created', title: '新对话', transcriptId: 'created-messages', createdAt: 5, updatedAt: 5 };
    conversations.set(created.id, created);
    snapshot(created, []);
    return created;
  },
  config: async () => ({ configured: true, model: 'local-fixture', contextBudget: 32768, maxOutputTokens: 4096, timeoutMs: 10000, files: { maxReadBytes: 65536, maxWriteBytes: 65536 } }),
  admission: unexpected,
  read: unexpected,
  cancel: unexpected,
  submit: unexpected,
  follow: unexpected,
};
const transcript: TranscriptTransport = {
  transcript: async (id) => transcripts.get(id)!,
  observeTranscript: async (id, accept, signal) => {
    accept({ type: 'baseline', snapshot: transcripts.get(id)! });
    if (signal.aborted) return;
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  },
};
function overview(id: string): ObserverOverview {
  const target = conversations.get(id)!;
  const messages = transcripts.get(target.transcriptId)!;
  return { transcriptId: target.transcriptId, messages: messages.messages.map((_, index) => ({ index, count: 0 })), executions: messages.end ? [{ id: `execution-${id}`, startedAt: '2026-10-13T00:00:00Z', status: 'succeeded', inputIndex: 0, response: { index: 1 }, selections: [], observedOffsetMs: 10, durationMs: 10, calls: [], availableMemoryIds: [], memoryChanges: [] }] : [] };
}
const observation: ObservationTransport = {
  overview: async (id) => overview(id),
  memory: async () => ({ items: [] }),
  source: unexpected,
  execution: async () => {
    throw new Error('本地样例只提供调用概览');
  },
  observe: async (id, accept, signal) => {
    const entity = transcripts.get(conversations.get(id)!.transcriptId)!;
    accept({ type: 'baseline', scopeId: `scope-${id}`, sequence: 0, overview: overview(id), memory: { items: [] }, transcript: { id: entity.id, revision: entity.revision, starts: entity.starts }, memories: { id: `memories-${id}`, sequence: 0 }, recorder: { id: `recorder-${id}`, revision: 0 }, entries: [], invocations: [] });
    if (signal.aborted) return;
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  },
};
const runtime = new ClientRuntime({ conversation, transcripts: transcript, observation });
const application = createApplication(runtime);
const host = document.getElementById('root')!;
const results: string[] = [];
const root = createRoot(host);
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function settle() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}
async function waitFor(condition: () => unknown, message: string) {
  const deadline = Date.now() + 3000;
  while (!condition() && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert(condition(), message);
  await settle();
}
async function check(name: string, work: () => Promise<void>) {
  await work();
  results.push(`PASS ${name}`);
  document.getElementById('results')!.textContent = results.join('\n');
}
function control(name: string) {
  const button = host.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`);
  assert(button, `${name} present`);
  return button;
}
async function openHistory(title: string) {
  control('历史对话').click();
  await waitFor(() => document.querySelector('.conversation-history-list button'), 'history list loaded');
  const target = [...document.querySelectorAll<HTMLButtonElement>('.conversation-history-list button')].find((button) => button.textContent?.includes(title));
  assert(target, `history entry ${title} present`);
  target.click();
  await waitFor(() => host.querySelector('h2')?.textContent === title && !document.querySelector('[role="dialog"]'), 'selected conversation opened');
}
try {
  root.render(
    <AppProvider application={application}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 600px) auto', gap: 20, maxWidth: 1080, height: 720, margin: '20px auto' }}>
        <ExplorerPanel />
        <div id="fixture-panel" style={{ width: 460, height: 720, display: 'flex', flexDirection: 'column', margin: '20px auto' }}>
          <ConversationPanel />
        </div>
      </div>
      <SettingsDialog />
    </AppProvider>,
  );
  await runtime.initialize();
  await settle();
  await check('navigation exposes new, history and settings beside the actual conversation title', async () => {
    await waitFor(() => host.querySelector('h2')?.textContent === initial.title, 'initial conversation rendered');
    assert(control('新建对话') && control('历史对话') && control('对话设置'), 'all controls available');
    assert(host.querySelector('[role="log"]')?.textContent?.includes('香山'), 'initial message content');
    assert(application.store.getState().data.rounds[0]?.id === `execution-${initial.id}`, 'initial graph belongs to the opened conversation');
  });
  await check('creating opens empty content and switching history restores the correct editable draft', async () => {
    application.store.setState({ draft: '原对话草稿', fileDraft: { sourcePath: 'trip.md', outputPath: '' }, history: '[{"role":"user","content":"待导入"}]' });
    control('新建对话').click();
    await waitFor(() => host.querySelector('h2')?.textContent === '新对话', 'new conversation rendered');
    assert(!host.querySelector('[role="log"]')?.textContent?.includes('香山'), 'old content not mixed with new title');
    assert(application.store.getState().draft === '', 'new input starts empty');
    assert(application.store.getState().data.rounds.length === 0 && !host.querySelector('.explorer-nav-card'), 'new conversation has no old rounds');
    application.store.getState().setDraft('新对话草稿');
    await openHistory(initial.title);
    assert(application.store.getState().draft === '原对话草稿', 'original draft restored');
    assert(application.store.getState().fileDraft.sourcePath === 'trip.md', 'file draft restored');
    assert(application.store.getState().history.includes('待导入'), 'message import remains local to the conversation');
    assert(!host.querySelector('.answer-reveal-all'), 'history answer does not replay');
    await openHistory('新对话');
    assert(application.store.getState().draft === '新对话草稿', 'new draft restored');
  });
  await check('opening another history isolates content and settings clearly call incoming content an import', async () => {
    await openHistory(other.title);
    assert(host.querySelector('[role="log"]')?.textContent?.includes('玉器'), 'selected content rendered');
    assert(application.store.getState().data.rounds[0]?.id === `execution-${other.id}`, 'graph follows the same conversation as its content');
    assert(application.store.getState().selectedId === `execution-${other.id}`, 'old QA selection is replaced');
    assert(!host.querySelector('[data-execution-id="execution-initial"]'), 'previous graph is unmounted');
    assert(!host.querySelector('[role="log"]')?.textContent?.includes('香山'), 'unselected content absent');
    control('对话设置').click();
    await waitFor(() => document.querySelector('[aria-label="导入消息 JSON"]'), 'settings import field present');
    application.store.getState().setSettingsOpen(false);
    await settle();
  });
  await check('the header keeps its controls inside the narrow conversation panel', async () => {
    document.getElementById('fixture-panel')!.style.width = '320px';
    await settle();
    const heading = host.querySelector<HTMLElement>('.conversation-heading')!;
    const navigation = host.querySelector<HTMLElement>('.conversation-controls')!;
    assert(navigation.getBoundingClientRect().right <= heading.getBoundingClientRect().right, 'controls remain visible');
    assert(heading.scrollWidth <= heading.clientWidth, 'header does not overflow');
    document.getElementById('fixture-panel')!.style.width = '460px';
    await settle();
  });
  results.push(`ALL ${results.length} CONVERSATION BROWSER CHECKS PASSED`);
} catch (error) {
  results.push(`FAIL ${error instanceof Error ? error.stack : String(error)}`);
}
document.getElementById('results')!.textContent = results.join('\n');
