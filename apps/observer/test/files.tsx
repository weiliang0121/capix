// Open /test/files.html through Vite. Local transport only: no filesystem, service or model access.
import { createRoot } from 'react-dom/client';
import { ClientRuntime, type ConversationTransport, type TranscriptTransport } from '@capix/client-runtime';
import type { ConversationSubmissionSnapshot, ConversationSubmissionFrame, ConversationSubmissionRequest, TranscriptFrame, TranscriptSnapshot, Message } from '@capix/protocol';
import { createApplication } from '../src/binding/application';
import { AppProvider } from '../src/state/react';
import { ConversationPanel } from '../src/features/conversation/ConversationPanel';
import '../src/styles.css';

const transcriptId = 'file-browser-fixture';
let transcript: TranscriptSnapshot = { id: transcriptId, revision: 0, start: 0, end: 0, starts: [0], messages: [] };
const listeners = new Set<(frame: TranscriptFrame) => void>();
const sent: ConversationSubmissionRequest[] = [];
let active: { snapshot: ConversationSubmissionSnapshot; receive: (frame: ConversationSubmissionFrame) => void; finish: () => void } | undefined;
const receipt = { path: 'summary.md', bytes: 48, digest: 'a'.repeat(64) };
function append(messages: readonly Message[]) {
  const start = transcript.end;
  transcript = { ...transcript, revision: transcript.revision + 1, end: start + messages.length, messages: [...transcript.messages, ...messages] };
  for (const accept of listeners) accept({ type: 'delta', event: { type: 'transcript', transcriptId, revision: transcript.revision, occurredAt: new Date().toISOString(), change: { kind: 'messages-appended', start, messages: [...messages] } } });
}
function publish(patch: Partial<ConversationSubmissionSnapshot>) {
  if (!active) throw new Error('No active fixture submission');
  active.snapshot = { ...active.snapshot, ...patch, revision: active.snapshot.revision + 1 };
  active.receive({ type: 'baseline', submission: active.snapshot });
}
const descriptor = { id: 'fixture-conversation', title: '测试对话', transcriptId, createdAt: 1, updatedAt: 1 };
const conversation: ConversationTransport = {
  conversations: async () => ({ conversations: [descriptor], defaultConversationId: descriptor.id }),
  conversation: async () => descriptor,
  activeSubmission: async () => ({ conversationId: descriptor.id, transcriptId: descriptor.transcriptId }),
  createConversation: async () => {
    throw new Error('This fixture does not create conversations.');
  },
  config: async () => ({ configured: true, model: 'local-fixture', contextBudget: 32768, maxOutputTokens: 4096, timeoutMs: 10000, files: { maxReadBytes: 65536, maxWriteBytes: 65536 } }),
  admission: async () => ({ conversationId: descriptor.id, transcriptId, status: 'ready' }),
  read: async () => {
    if (!active) throw new Error('No active submission');
    return { type: 'baseline', submission: active.snapshot };
  },
  follow: async () => {
    throw new Error('Unexpected follow');
  },
  cancel: async () => {
    if (!active) throw new Error('No active submission');
    publish({ cancelRequested: true, result: { status: 'cancelled' }, admission: { conversationId: descriptor.id, transcriptId, status: 'ready' } });
    active.finish();
    return { type: 'baseline', submission: active.snapshot };
  },
  submit: async (request, receive) => {
    sent.push(request);
    const start = transcript.end;
    append(request.input.messages);
    const initial: ConversationSubmissionSnapshot = { conversationId: request.conversationId, submissionId: request.submissionId, revision: 1, input: { transcriptId, start, end: transcript.end }, executions: [], integrity: { status: 'complete' }, task: request.input.fileTask ? { kind: 'file', task: request.input.fileTask } : { kind: 'reply' }, ...(request.input.fileTask?.output ? { fileOutput: { status: 'pending', path: request.input.fileTask.output.path } } : {}) };
    if (sent.length === 1) {
      await new Promise<void>((resolve) => {
        active = { snapshot: initial, receive, finish: resolve };
        receive({ type: 'baseline', submission: initial });
      });
      return;
    }
    const index = transcript.end;
    append([{ role: 'assistant', content: '请补充文档需要保留的重点。' }]);
    receive({ type: 'baseline', submission: { ...initial, revision: 2, answer: { transcriptId, index }, result: { status: 'completed' }, admission: { conversationId: descriptor.id, transcriptId, status: 'ready' }, fileOutput: { status: 'not-created', path: request.input.fileTask!.output!.path, reason: 'not-started' } } });
  },
};
const transcripts: TranscriptTransport = {
  transcript: async () => transcript,
  observeTranscript: async (_id, accept, signal) => {
    accept({ type: 'baseline', snapshot: transcript });
    listeners.add(accept);
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    listeners.delete(accept);
  },
};
const runtime = new ClientRuntime({ conversation, transcripts });
const application = createApplication(runtime);
const host = document.getElementById('root')!;
const root = createRoot(host);
const results: string[] = [];
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
try {
  root.render(
    <AppProvider application={application}>
      <div style={{ width: 540, height: 780, display: 'flex', flexDirection: 'column', margin: '20px auto' }}>
        <ConversationPanel />
      </div>
    </AppProvider>,
  );
  await runtime.initialize();
  await settle();
  await check('capability enables optional relative-path controls without changing ordinary conversation', async () => {
    await waitFor(() => host.querySelector('.file-task-controls'), 'file controls mounted after configuration projection');
    const details = host.querySelector<HTMLDetailsElement>('.file-task-controls');
    assert(details, 'file controls present');
    details.open = true;
    assert(host.querySelector('[aria-label="来源文件相对路径"]'), 'source path accessible');
    assert(host.querySelector('[aria-label="结果文件相对路径"]'), 'output path accessible');
    assert(application.store.getState().data.config?.files?.maxReadBytes === 65536, 'binding carries configured capability');
  });
  await check('submission freezes paths and waiting input displays its own file task', async () => {
    application.store.getState().setDraft('总结这份文档');
    application.store.getState().setFileDraft({ sourcePath: 'notes.md', outputPath: 'summary.md' });
    await application.commands.submit();
    await settle();
    await waitFor(() => host.querySelector('.file-result')?.textContent?.includes('等待创建结果文件'), 'pending receipt rendered');
    assert(sent.length === 1 && sent[0]!.input.fileTask?.sourcePath === 'notes.md', 'first request carries path');
    assert(host.querySelector('.file-result')?.textContent?.includes('等待创建结果文件'), 'pending result is independent of answer');
    application.store.getState().setDraft('提炼另一份文档');
    application.store.getState().setFileDraft({ sourcePath: 'other.md', outputPath: 'other-result.md' });
    await application.commands.submit();
    await settle();
    await waitFor(() => host.querySelector('.message-queue')?.textContent?.includes('other.md → other-result.md'), 'queued task rendered');
    assert(sent.length === 1, 'queue does not issue second request yet');
    assert(host.querySelector('.message-queue')?.textContent?.includes('other.md → other-result.md'), 'waiting paths visible');
    assert(application.store.getState().fileDraft.sourcePath === '', 'locally accepted draft clears');
  });
  await check('confirmed publication remains visible after cancellation even without assistant text', async () => {
    publish({ fileOutput: { status: 'created', receipt } });
    await settle();
    await waitFor(() => host.querySelector('.file-result')?.textContent?.includes('结果文件已创建'), 'receipt rendered before cancellation');
    assert(host.querySelector('.file-result')?.textContent?.includes('结果文件已创建'), 'receipt shown before answer');
    const stop = host.querySelector<HTMLButtonElement>('[aria-label="停止当前回答"]');
    assert(stop, 'current invocation can still be stopped');
    stop.click();
    await settle();
    await settle();
    await waitFor(() => sent.length === 2 && !host.querySelector('[aria-label="停止当前回答"]'), 'queued turn settles after cancellation');
    const first = host.querySelector('.file-result');
    assert(first?.textContent?.includes('summary.md') && first.textContent.includes('结果文件已创建'), 'cancel retains receipt');
    assert(sent.length === 2, 'waiting turn automatically proceeds');
  });
  await check('clarification answer explains that file creation was not executed', async () => {
    await waitFor(() => host.querySelectorAll('.file-result').length === 2, 'second file result rendered');
    const cards = host.querySelectorAll('.file-result');
    assert(cards.length === 2 && cards[1]!.textContent?.includes('未执行文件创建'), 'second output differs from created');
    assert(!host.querySelector('.message-queue'), 'finished queue hidden');
    assert(!host.querySelector('[aria-label="停止当前回答"]'), 'terminal run releases stop control');
    assert(runtime.getSnapshot().observation.enabled === false, 'no observation dependency');
  });
  results.push(`ALL ${results.length} FILE BROWSER CHECKS PASSED`);
} catch (error) {
  results.push(`FAIL ${error instanceof Error ? error.stack : String(error)}`);
}
document.getElementById('results')!.textContent = results.join('\n');
