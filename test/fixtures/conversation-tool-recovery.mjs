import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { createConversationHostAssembly, loadConversationContent } from '@capix/conversation-service/assembly';
import { ToolStages } from '@capix/conversation-service/tools/hosting';
import { ChatCompletionsProvider } from '@weiliang0121/capix-model-provider';
import { PersistenceError } from '@weiliang0121/capix-diagnostics';
import { MemoryViewSource } from '@weiliang0121/capix-memory';
import { TranscriptViewSource } from '@weiliang0121/capix-transcript';
import { Runner } from '@weiliang0121/capix-runtime';

const [mode, database, boundary = 'none'] = process.argv.slice(2);
const store = ConversationStore.open(database);
const identityPath = `${database}.root`;
const countPath = `${database}.requests`;
let pending;
let archiveReads = 0;
let interactionReads = 0;
const persistenceFailure = new PersistenceError('fixture.read', new Error('original disk failure'));
const armed = mode === 'crash';
function root() {
  return store.checkpoints.listRoots().findLast((head) => head.image.contract.key === 'conversation.tools.scene');
}
function counts() {
  return existsSync(countPath) ? readFileSync(countPath, 'utf8').trim().split('\n') : [];
}
function report(extra = {}) {
  return { ...extra, state: store.load(), roots: store.checkpoints.listRoots().map((head) => ({ id: head.image.frame.owner.contextId, status: head.delivery?.status })), collections: store.exchanges.list().items, requests: counts(), archiveReads, interactionReads };
}
function halt() {
  writeFileSync(identityPath, root().image.frame.owner.contextId);
  console.log(JSON.stringify(report({ boundary })));
  process.exit(73);
}
const contentPort = {
  load: () => store.load(),
  initialize: (value) => store.initialize(value),
  assertAvailable: () => store.assertAvailable(),
  view: store.view,
  transcript: {
    commit(change) {
      store.transcript.commit(change);
      if (armed && boundary === 'assistant' && change.kind === 'append' && change.fixed) halt();
    },
  },
  memories: {
    commit(change) {
      store.memories.commit(change);
      if (armed && boundary === 'memory' && change.fixed) halt();
    },
  },
};
const content = loadConversationContent(contentPort);
if (!content.transcript.length) content.transcript.append({ role: 'user', content: '历史事实：我喜欢成都川菜。' });
if (armed && boundary === 'active-memory') {
  const values = content.memories.apply(['活跃的既有偏好', '退出视图的既有偏好'].map((text) => ({ action: 'create', memoryId: null, change: text, sourceIndexes: [0], result: { topic: text, content: text, sourceIndexes: [0] } })));
  content.view.includeSync({ messages: new TranscriptViewSource(content.transcript), memories: new MemoryViewSource(content.memories) }, [{ source: 'memories', key: values[0].id }], store.view);
}
const port = {
  ...contentPort,
  archiveUsage: () => store.archiveUsage(),
  checkpoints: {
    listRoots: () => store.checkpoints.listRoots(),
    read(id) {
      const value = store.checkpoints.read(id);
      if (!value) return value;
      const copy = structuredClone(value);
      if (mode === 'changed-model-reference' && copy.image.contract.key === 'conversation.tools.completion') {
        const reference = copy.image.point === 'completed' ? copy.image.state.reference : copy.image.state;
        reference.id = 'other-model-interaction';
      }
      if (mode === 'changed-preparation' && copy.image.contract.key === 'conversation.tools.prepare') copy.image.state.materials.basis.viewRevision++;
      return copy;
    },
    finish: (...args) => store.checkpoints.finish(...args),
    save(image, revision) {
      const value = store.checkpoints.save(image, revision);
      const key = image.contract.key;
      if (armed && boundary === 'prepared' && key === 'conversation.tools.archived-answer' && image.point === 'prepared') halt();
      if (armed && boundary === 'waiting' && key === 'conversation.tools.archived-answer' && image.point === 'waiting') halt();
      if (armed && boundary === 'tool' && key === 'conversation.history.read-message') halt();
      if (key === 'conversation.tools.completion' && image.point === 'established') {
        if (armed && boundary === 'missing-feedback') halt();
        const release = pending;
        pending = undefined;
        release?.();
      }
      if (key === 'conversation.completion-reply' && image.point === 'waiting') {
        if (armed && boundary === 'missing-memory-feedback') halt();
        const release = pending;
        pending = undefined;
        release?.();
      }
      return value;
    },
  },
  interactions: {
    create: (state) => store.interactions.create(state),
    read(id) {
      interactionReads++;
      if (mode === 'interaction-read-failure') throw persistenceFailure;
      const saved = store.interactions.read(id);
      if (!saved || !saved.request.tools) return saved;
      const value = structuredClone(saved);
      if (mode === 'changed-model-request') value.request.messages[0].content += 'different basis';
      if (mode === 'changed-model-reply' && value.feedback) ((value.feedback.payload.output = [{ kind: 'text', text: 'different final answer' }]), (value.feedback.payload.termination = { kind: 'completed', reason: 'stop' }));
      return value;
    },
    commit(change) {
      store.interactions.commit(change);
      if (armed && ['feedback', 'active-memory'].includes(boundary) && change.state.feedback && change.state.request.tools) halt();
    },
  },
  exchanges: {
    list: (...args) => store.exchanges.list(...args),
    load(id) {
      archiveReads++;
      if (mode === 'archive-read-failure') throw persistenceFailure;
      if (mode === 'missing-archive') return undefined;
      const saved = store.exchanges.load(id);
      if (!saved) return saved;
      const value = structuredClone(saved);
      if (mode === 'changed-feedback' && value.state.entries[0]?.feedback[0]) value.state.entries[0].feedback[0].content[0].text += 'changed';
      if (mode === 'changed-intake-operation' && value.state.entries[0]) value.state.entries[0].operation.childContextId = 'other-model-child';
      return value;
    },
    initialize(...args) {
      store.exchanges.initialize(...args);
      if (armed && boundary === 'initialized') halt();
    },
    commit(change) {
      store.exchanges.commit(change);
      if (armed && boundary === 'tool-feedback' && change.entry.feedback.length) halt();
    },
  },
};
const inspector = new ChatCompletionsProvider({
  endpoint: 'https://fixture.invalid/chat/completions',
  apiKey: 'offline',
  model: 'fixture',
  fetch() {
    throw new Error('Offline fixture must not fetch');
  },
});
const model = {
  inspectRequest: inspector.inspectRequest.bind(inspector),
  complete(request) {
    const memory = request.responseFormat === 'json_object';
    const kind = memory ? 'memory' : request.exchanges?.length ? 'answer' : 'tools';
    appendFileSync(countPath, `${kind}\n`);
    const output = kind === 'tools' ? [{ kind: 'tool-call', id: 'original-read', name: 'read_message', arguments: { encoding: 'json-text', text: '{"index":0}' } }] : [{ kind: 'text', text: memory ? JSON.stringify({ changes: [{ action: 'create', memoryId: null, change: '明确偏好', sourceIndexes: [1], result: { topic: '饮食偏好', content: '用户喜欢川菜。', sourceIndexes: [1] } }] }) : '你此前提到喜欢成都川菜。' }];
    const reply = { formatVersion: 1, id: `reply-${kind}`, model: 'fixture', output, termination: { kind: 'completed', reason: kind === 'tools' ? 'tool_calls' : 'stop' }, usage: null, native: { format: 'chat-completions', version: 1 } };
    return new Promise((resolve) => {
      pending = () => resolve(reply);
    });
  },
};
const assembly = createConversationHostAssembly({ content, store: port, model, configuration: mode === 'changed-configuration' ? 'test-v2' : 'test-v1', answerMode: 'tools', ...(mode === 'changed-budget' ? { outputBudget: { answer: 8192 } } : {}), ...(mode === 'changed-policy' ? { toolPolicy: { history: { maxReadLength: 100 } } } : {}) });
const runner = new Runner(assembly.scene, assembly.resources, assembly.interactions, { checkpoints: { store: assembly.checkpoints } }).build();
const entry = assembly.entry(runner);
const stages = [];
const stageSource = new ToolStages(runner.observation, assembly.toolLoop);
stageSource.subscribe({
  receive: (event) => {
    stages.push(event.stage);
  },
});
try {
  let result;
  if (mode === 'crash' || mode === 'run') result = await entry.run('我喜欢什么菜？');
  else if (mode === 'list') result = assembly.listRecoveries();
  else {
    if (mode === 'new-input') content.transcript.append({ role: 'user', content: '新的问题' });
    result = await entry.resume(readFileSync(identityPath, 'utf8'));
  }
  await assembly.interactions.settled();
  console.log(JSON.stringify(report({ result, stages, loaded: assembly.exchanges.loadedCount })));
} catch (error) {
  console.log(JSON.stringify(report({ error: { code: error.code, message: error.message, persistence: error === persistenceFailure }, loaded: assembly.exchanges.loadedCount })));
  process.exitCode = 1;
} finally {
  await assembly.interactions.settled();
  stageSource.close();
  assembly.interactions.close();
  store.close();
}
