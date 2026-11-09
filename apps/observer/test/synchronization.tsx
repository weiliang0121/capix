// Open /test/synchronization.html through Vite. All delivery is local; no service or model is used.
import { createRoot } from 'react-dom/client';
import { ClientRuntime, TranscriptConnectionError, type ConversationTransport, type TranscriptTransport } from '@capix/client-runtime';
import type { TranscriptFrame, TranscriptSnapshot } from '@weiliang0121/capix-protocol';
import { createApplication } from '../src/binding/application';
import { AppProvider } from '../src/state/react';
import { ConversationPanel } from '../src/features/conversation/ConversationPanel';
import '../src/styles.css';

interface Connection {
  readonly accept: (frame: TranscriptFrame) => void;
  readonly fail: (error: unknown) => void;
  readonly signal: AbortSignal;
}
const connections: Connection[] = [];
const transcriptId = 'browser-synchronization';
const snapshot: TranscriptSnapshot = {
  id: transcriptId,
  revision: 1,
  start: 0,
  end: 2,
  starts: [0],
  messages: [
    { role: 'user', content: '之前的问题' },
    { role: 'assistant', content: '已经同步的完整回答，断线后仍可阅读。' },
  ],
};
const restored: TranscriptSnapshot = { ...snapshot, revision: 2, end: 4, messages: [...snapshot.messages, { role: 'user', content: '离线期间的问题' }, { role: 'assistant', content: '重新连接后补齐的回答。' }] };
const unexpected = async (): Promise<never> => {
  throw new Error('This fixture must not submit, cancel or read any service task.');
};
const descriptor = { id: 'fixture-conversation', title: '测试对话', transcriptId, createdAt: 1, updatedAt: 1 };
const conversation: ConversationTransport = {
  conversations: async () => ({ conversations: [descriptor], defaultConversationId: descriptor.id }),
  conversation: async () => descriptor,
  activeSubmission: async () => ({ conversationId: descriptor.id, transcriptId: descriptor.transcriptId }),
  createConversation: async () => {
    throw new Error('This fixture does not create conversations.');
  },
  config: async () => ({ configured: true, model: 'local-fixture', contextBudget: 32768, maxOutputTokens: 4096, timeoutMs: 10_000 }),
  admission: unexpected,
  read: unexpected,
  cancel: unexpected,
  submit: unexpected,
  follow: unexpected,
};
const transcripts: TranscriptTransport = {
  transcript: unexpected,
  observeTranscript: (_id, accept, signal) =>
    new Promise<void>((resolve, reject) => {
      connections.push({ accept, fail: reject, signal });
      signal.addEventListener('abort', () => resolve(), { once: true });
    }),
};
const runtime = new ClientRuntime({ conversation, transcripts });
const application = createApplication(runtime);
const host = document.getElementById('root')!;
const root = createRoot(host);
const results: string[] = [];
let mounted = true;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function settle() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}
async function waitForConnection(count: number) {
  const deadline = Date.now() + 3000;
  while (connections.length < count && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert(connections.length === count, `expected ${count} connections, got ${connections.length}`);
  await settle();
  return connections[count - 1]!;
}
function banner() {
  return host.querySelector<HTMLElement>('.conversation-panel > .notice');
}
function reconnect() {
  return banner()?.querySelector<HTMLButtonElement>('button');
}
function cachedAnswer() {
  assert(host.querySelector('[role="log"]')?.textContent?.includes(snapshot.messages[1]!.content), 'cached answer must remain readable');
}
async function check(name: string, work: () => Promise<void>) {
  await work();
  results.push(`PASS ${name}`);
  document.getElementById('results')!.textContent = results.join('\n');
}

try {
  await check('the actual runtime, binding and panel wait for an initial baseline before becoming ready', async () => {
    root.render(
      <AppProvider application={application}>
        <div style={{ width: 540, height: 700, display: 'flex', flexDirection: 'column', margin: '20px auto' }}>
          <ConversationPanel />
        </div>
      </AppProvider>,
    );
    const connection = await waitForConnection(1);
    assert(banner()?.textContent?.includes('正在建立对话连接'), 'unknown collection uses initialization progress');
    assert(!reconnect(), 'active initialization does not expose redundant reconnect');
    connection.accept({ type: 'baseline', snapshot });
    await runtime.initialize();
    await settle();
    cachedAnswer();
    assert(!banner(), 'initial synchronization clears its progress notice');
    assert(runtime.getSnapshot().observation.enabled === false, 'message synchronization does not require observation');
  });
  await check('transient interruption automatically retries while cached content remains readable', async () => {
    connections[0]!.fail(new TranscriptConnectionError('PRIVATE_NETWORK_DETAILS'));
    await settle();
    assert(banner()?.textContent?.includes('正在自动重连'), 'backoff is presented as active recovery');
    assert(!reconnect(), 'automatic backoff has no competing reconnect button');
    assert(!host.textContent?.includes('PRIVATE_NETWORK_DETAILS'), 'raw network errors stay out of the conversation');
    cachedAnswer();
    const next = await waitForConnection(2);
    assert(banner()?.textContent?.includes('正在重新连接消息'), 'replacement connection waits for its own baseline');
    assert(!reconnect(), 'connecting does not pretend to be terminal failure');
    next.accept({ type: 'baseline', snapshot: restored });
    await settle();
    assert(!banner(), 'successful recovery removes the notice');
    cachedAnswer();
    assert(host.textContent?.includes(restored.messages[3]!.content), 'new baseline adds the missing answer');
    assert(!host.querySelector('.answer-reveal-all'), 'recovered history is shown statically');
    assert(connections[0]!.signal.aborted, 'retired transport has been stopped');
  });
  await check('a nonrecoverable failure provides one explicit reconnect action without losing the answer', async () => {
    connections[1]!.fail(new Error('PRIVATE_CONTRACT_DETAILS'));
    await settle();
    assert(banner()?.textContent?.includes('消息同步暂不可用'), 'terminal synchronization failure is explicit');
    assert(reconnect()?.textContent === '重新连接', 'terminal failure offers manual reconnection');
    assert(!host.textContent?.includes('PRIVATE_CONTRACT_DETAILS'), 'raw failure is not presentation text');
    cachedAnswer();
    reconnect()!.click();
    const next = await waitForConnection(3);
    assert(!reconnect(), 'manual reconnect removes its stale action while awaiting baseline');
    next.accept({ type: 'baseline', snapshot: restored });
    await settle();
    assert(!banner(), 'manual recovery clears failure');
    cachedAnswer();
    assert(application.store.getState().notice === '', 'initialization rejection did not leave a global error notice');
  });
  await check('explicitly stopped synchronization remains stopped until its reconnect button is used', async () => {
    runtime.stopTranscript(transcriptId);
    await settle();
    assert(banner()?.textContent?.includes('消息同步已停止'), 'stop differs from a network failure');
    assert(reconnect(), 'stopped connection can be explicitly reestablished');
    assert(connections.length === 3, 'stop never starts automatic recovery');
    cachedAnswer();
    reconnect()!.click();
    const next = await waitForConnection(4);
    next.accept({ type: 'baseline', snapshot: restored });
    await settle();
    assert(!banner(), 'explicit restart restores a live view');
    cachedAnswer();
  });
  await check('unmount cancels a pending retry instead of reconnecting in the background', async () => {
    connections[3]!.fail(new TranscriptConnectionError('temporary'));
    await settle();
    assert(banner()?.textContent?.includes('正在自动重连'), 'retry is pending before unmount');
    root.unmount();
    mounted = false;
    await new Promise<void>((resolve) => setTimeout(resolve, 650));
    assert(connections.length === 4, 'unmounted application does not create a replacement connection');
    assert(runtime.getSnapshot().transcripts.get(transcriptId)?.sync.status === 'stopped', 'unmount stops only the synchronization lifecycle');
  });
  results.push(`ALL ${results.length} SYNCHRONIZATION BROWSER CHECKS PASSED`);
} catch (error) {
  results.push(`FAIL ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  if (mounted) root.unmount();
}
document.getElementById('results')!.textContent = results.join('\n');
