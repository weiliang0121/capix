import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ConversationControls } from '../../apps/observer/.test-dist/features/conversation/ConversationControls.js';
import { ConversationHistoryList } from '../../apps/observer/.test-dist/features/conversation/ConversationHistory.js';
import { Composer } from '../../apps/observer/.test-dist/features/conversation/Composer.js';
import { createAppStore } from '../../apps/observer/.test-dist/state/store.js';
import { connectAppStore } from '../../apps/observer/.test-dist/binding/application.js';
import { createDataProjection } from '../../apps/observer/.test-dist/binding/data.js';
import { submitDraft } from '../../apps/observer/.test-dist/binding/submit.js';
import { projectConversationChange } from '../../apps/observer/.test-dist/binding/conversations.js';
import { installFrames } from '../web/frames.mjs';
import { client, transport } from '../client/fixtures.mjs';

const requireApp = createRequire(new URL('../../apps/observer/package.json', import.meta.url));
const { createElement } = requireApp('react');
const { renderToStaticMarkup } = requireApp('react-dom/server');
const render = (component, props) => renderToStaticMarkup(createElement(component, props));
const button = (html, label) => [...html.matchAll(/<button\b[^>]*>/g)].find(([tag]) => tag.includes(`aria-label="${label}"`))?.[0];
const first = { id: 'first', title: '第一段交流', transcriptId: 'transcript-first', createdAt: 1, updatedAt: 2 };
const second = { id: 'second', title: '第二段交流', transcriptId: 'transcript-second', createdAt: 3, updatedAt: 4 };
const noop = () => {};

function stateFor(initial, conversation, messages = []) {
  return {
    ...initial,
    conversation,
    conversations: [second, first],
    config: { configured: true, model: 'fixture', contextBudget: 4096 },
    initialization: { status: 'succeeded', attempt: 1 },
    transcriptId: conversation.transcriptId,
    transcripts: new Map([[conversation.transcriptId, { snapshot: { id: conversation.transcriptId, start: 0, end: messages.length, revision: messages.length, starts: [0], messages }, sync: { status: 'live' } }]]),
    messages,
    canSwitchConversation: true,
    observation: { ...initial.observation, overview: { transcriptId: conversation.transcriptId, messages: [], executions: [] } },
  };
}

test('new, history and settings share one accessible management group; only switching actions require readiness', () => {
  const props = { switching: false, onCreate: noop, onHistory: noop, onSettings: noop };
  const busy = render(ConversationControls, { ...props, canSwitch: false });
  assert.match(busy, /role="group" aria-label="对话管理"/);
  assert.match(button(busy, '新建对话'), /disabled=""/);
  assert.doesNotMatch(button(busy, '历史对话'), /disabled=/);
  assert.doesNotMatch(button(busy, '对话设置'), /disabled=/);
  const ready = render(ConversationControls, { ...props, canSwitch: true });
  assert.doesNotMatch(button(ready, '新建对话'), /disabled=/);
  const switching = render(ConversationControls, { ...props, canSwitch: true, switching: true });
  assert.match(button(switching, '新建对话'), /disabled=""/);
});

test('history remains readable while busy and only the current entry stays selectable', () => {
  const html = render(ConversationHistoryList, { conversations: [first, second], currentId: first.id, canSwitch: false, switching: false, onOpen: noop });
  assert.match(html, /第一段交流/);
  assert.match(html, /第二段交流/);
  assert.match(html, /aria-current="true"/);
  assert.equal([...html.matchAll(/disabled=""/g)].length, 1);
  assert.equal([...html.matchAll(/<time dateTime=/g)].length, 2);
  const switching = render(ConversationHistoryList, { conversations: [first, second], currentId: first.id, canSwitch: true, switching: true, onOpen: noop });
  assert.equal([...switching.matchAll(/disabled=""/g)].length, 2);
});

test('opening a target disables sending and editing while the prior view still owns its drafts', () => {
  const html = render(Composer, { configured: true, loaded: true, disabled: true, draft: '原对话草稿', onDraft: noop, onSubmit: async () => {}, onCancel: async () => {}, files: { maxReadBytes: 1024, maxWriteBytes: 1024 }, fileDraft: { sourcePath: 'notes.md', outputPath: '' }, onFileDraft: noop });
  assert.match(button(html, '发送消息'), /disabled=""/);
  assert.match(html, /<textarea[^>]*disabled=""/);
  assert.equal([...html.matchAll(/<input[^>]*disabled=""/g)].length, 2);
});

test('a successful switch publishes content and local ownership together, restores input, and does not replay prior answers', async (t) => {
  const frames = installFrames(t);
  const initial = client({ conversation: transport() }).getSnapshot();
  const firstMessages = [
    { role: 'user', content: '第一段问题' },
    { role: 'assistant', content: '第一段回答' },
  ];
  let state = stateFor(initial, first, firstMessages);
  let notify;
  const runtime = {
    getSnapshot: () => state,
    subscribe: (listener) => {
      notify = listener;
      return noop;
    },
    initialize: async () => {},
    startObservation: () => noop,
    stopTranscript: noop,
  };
  const store = createAppStore();
  const disconnect = connectAppStore(store, runtime);
  t.after(disconnect);
  store.setState({ draft: '第一段草稿', fileDraft: { sourcePath: 'first.md', outputPath: 'result.md' }, history: '[{"role":"user","content":"待导入"}]', selectedId: 'old-round', inspection: { executionId: 'old-round' }, memoryOpen: true, settingsOpen: true, search: '第一段', conversationFocus: 'old-focus', budget: '8192' });
  await frames.flush();
  const seen = [];
  const unsubscribe = store.subscribe((next) => seen.push(next));
  t.after(unsubscribe);
  state = { ...state, switching: true, canSwitchConversation: false };
  notify();
  await frames.flush();
  assert.equal(store.getState().draft, '第一段草稿');
  assert.equal(store.getState().data.activeConversation.id, first.id);
  seen.length = 0;
  state = stateFor(initial, second, [{ role: 'user', content: '第二段问题' }]);
  notify();
  await frames.flush();
  assert.equal(seen.length, 1, 'one frame cannot expose a new title with old selection or content');
  const next = seen[0];
  assert.equal(next.data.activeConversation.id, second.id);
  assert.equal(next.data.conversation[0].message.content, '第二段问题');
  assert.equal(next.draft, '');
  assert.deepEqual(next.fileDraft, { sourcePath: '', outputPath: '' });
  assert.equal(next.history, '[]');
  assert.equal(next.selectedId, '');
  assert.equal(next.inspection, undefined);
  assert.equal(next.memoryOpen, false);
  assert.equal(next.settingsOpen, false);
  assert.equal(next.conversationFocus, undefined);
  assert.equal(next.search, '');
  assert.deepEqual(next.matches, []);
  store.setState({ draft: '第二段草稿', fileDraft: { sourcePath: 'second.md', outputPath: '' } });
  state = stateFor(initial, first, firstMessages);
  notify();
  await frames.flush();
  assert.equal(store.getState().draft, '第一段草稿');
  assert.deepEqual(store.getState().fileDraft, { sourcePath: 'first.md', outputPath: 'result.md' });
  assert.match(store.getState().history, /待导入/);
  assert.ok(
    store.getState().data.conversation.every((row) => !row.reveal),
    'reopened formal history is static',
  );
  assert.equal(store.getState().conversationDrafts.get(second.id).draft, '第二段草稿');
});

test('title refresh and failed opening retain local state; the initial conversation adopts preexisting edits', () => {
  const store = createAppStore();
  store.setState({ draft: '连接前输入', history: '[{"role":"user","content":"导入"}]' });
  const firstOpen = projectConversationChange(store.getState(), first.id);
  assert.equal(firstOpen.draft, '连接前输入');
  store.setState({ ...firstOpen, data: { ...store.getState().data, activeConversation: first } });
  store.getState().inspect('round', 'call');
  assert.deepEqual(projectConversationChange(store.getState(), first.id), {});
  const initial = client({ conversation: transport() }).getSnapshot();
  const project = createDataProjection();
  const state = stateFor(initial, first, [{ role: 'user', content: '第一段消息' }]);
  project(state);
  const failure = project({ ...state, conversationError: new Error('目标对话加载失败'), switching: false });
  assert.equal(failure.activeConversation.id, first.id);
  assert.equal(failure.conversation[0].message.content, '第一段消息');
  assert.match(failure.conversationError, /目标对话加载失败/);
  assert.equal(store.getState().inspection.callId, 'call');
});

test("a completed runtime switch cannot send the previous frame's draft into the new conversation", async () => {
  const store = createAppStore();
  store.setState({ data: { ...store.getState().data, activeConversation: first }, draft: '只发往第一段对话' });
  let sent = false;
  const runtime = {
    getSnapshot: () => ({ conversation: second, switching: false, config: { configured: true } }),
    enqueue: () => {
      sent = true;
    },
  };
  await submitDraft(store, runtime);
  assert.equal(sent, false);
  assert.equal(store.getState().draft, '只发往第一段对话');
});
