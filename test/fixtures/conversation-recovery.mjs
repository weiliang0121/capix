import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { assertConversationRecovery, createConversationInteractions, createConversationResources, createMaterialConversationScene, loadConversationContent } from '@capix/conversation-service/assembly';
import { Runner } from '@capix/server-runtime';

const [mode, database, boundary = 'none'] = process.argv.slice(2);
const store = ConversationStore.open(database);
const identityPath = `${database}.root`;
const countPath = `${database}.requests`;
const query = '请记住我偏好简短的中文回答。';
const answer = '好的，后续我会使用简短的中文回答。';
let pending;
let armed = mode === 'crash';

function rootId() {
  const root = store.checkpoints.listRoots().findLast((head) => head.image.contract.key === 'conversation.material-scene');
  if (!root) throw new Error('No root checkpoint was established');
  return root.image.frame.owner.contextId;
}

function halt() {
  writeFileSync(identityPath, rootId());
  process.stdout.write(JSON.stringify({ boundary, state: store.load() }));
  // Real process loss: no thrown business exception, no cancellation, no final delivery.
  process.exit(73);
}

function handledProposals() {
  const queue = [...store.checkpoints.listRoots()];
  let count = 0;
  for (const head of queue) {
    for (const child of head.image.frame.children) {
      if (head.image.contract.key === 'conversation.memory.maintenance' && child.key === 'propose' && child.state.kind === 'failed' && child.state.reception?.kind === 'handled') count++;
      const saved = store.checkpoints.read(child.identity.contextId);
      if (saved) queue.push(saved);
    }
  }
  return count;
}

const persistence = {
  assertAvailable: () => store.assertAvailable(),
  load: () => store.load(),
  initialize: (state) => store.initialize(state),
  transcript: {
    commit(change) {
      store.transcript.commit(change);
      if (armed && boundary === 'assistant' && change.kind === 'append' && change.fixed && change.messages[0]?.role === 'assistant') halt();
    },
  },
  memories: {
    commit(change) {
      store.memories.commit(change);
      if (armed && boundary === 'memory' && change.fixed) halt();
    },
  },
  view: store.view,
};
const content = loadConversationContent(persistence);
const model = {
  complete(request) {
    const kind = request.responseFormat === 'json_object' ? 'memory' : 'answer';
    appendFileSync(countPath, `${kind}\n`);
    const context = kind === 'memory' ? JSON.parse(request.messages.at(-1).content) : undefined;
    const prior = context?.memories[0];
    const sourceIndex = context ? context.acceptedIndex - 1 : 0;
    const text = kind === 'answer' ? answer : boundary === 'invalid-memory-json' ? 'not JSON' : JSON.stringify({ changes: [{ action: prior ? 'update' : 'create', memoryId: prior?.id ?? null, change: '用户表达偏好', sourceIndexes: [sourceIndex], result: { topic: '回答偏好', content: prior ? '再次确认偏好简短的中文回答。' : '偏好简短的中文回答。', sourceIndexes: [sourceIndex] } }] });
    const reply = { id: `reply-${kind}`, model: 'offline-crash-fixture', formatVersion: 1, output: [{ kind: 'text', text: text }], native: { format: 'chat-completions', version: 1 }, termination: { kind: kind === 'memory' && boundary === 'invalid-memory-length' ? 'incomplete' : 'completed', reason: kind === 'memory' && boundary === 'invalid-memory-length' ? 'length' : 'stop' }, usage: null };
    return new Promise((resolve, reject) => {
      pending = () => (kind === 'memory' && boundary.startsWith('handled-memory-failure') ? reject(new Error('Offline memory provider network failure')) : resolve(reply));
    });
  },
};
const interactionPort = {
  create: (state) => store.interactions.create(state),
  read: (id) => store.interactions.read(id),
  commit(change) {
    store.interactions.commit(change);
    if (armed && boundary === 'feedback' && change.state.feedback && change.state.request.stream === true) halt();
    if (armed && boundary.startsWith('invalid-memory') && change.state.feedback && change.state.request.responseFormat === 'json_object') halt();
  },
};
const checkpoints = {
  read: (id) => store.checkpoints.read(id),
  finish: (...args) => store.checkpoints.finish(...args),
  save(image, revision) {
    const head = store.checkpoints.save(image, revision);
    if (armed && boundary === 'materials' && image.contract.key === 'conversation.material-preparation' && image.point === 'captured') halt();
    if (armed && boundary.startsWith('handled-memory-failure') && image.contract.key === 'conversation.memory.maintenance' && image.point === (boundary.endsWith('completed') ? 'completed' : 'proposalReceived') && image.frame.input.message.role === 'assistant') halt();
    if (image.contract.key === 'conversation.completion-reply' && image.point === 'waiting') {
      if (armed && boundary === 'missing-feedback') halt();
      if (armed && boundary === 'missing-memory-feedback' && store.interactions.read(image.frame.input.id)?.request.responseFormat === 'json_object') halt();
      const release = pending;
      pending = undefined;
      release?.();
    }
    return head;
  },
};
const interactions = createConversationInteractions(model, interactionPort);
const budget = mode.startsWith('changed-budget') ? { answer: 8192, memory: 8192 } : undefined;
const resources = createConversationResources(content, model, store.view, 'test-v1');
const runner = new Runner(createMaterialConversationScene(budget), resources, interactions, { checkpoints: { store: checkpoints } }).build();
try {
  let result;
  if (mode === 'crash-history') {
    await runner.run(query);
    await interactions.settled();
    armed = true;
    result = await runner.run('再次确认这个偏好。');
  } else if (mode === 'crash' || mode === 'run') result = await runner.run(query);
  else {
    const id = readFileSync(identityPath, 'utf8');
    if (mode === 'new-input') content.transcript.append({ role: 'user', content: '另一个新提交' });
    if (mode !== 'changed-budget-direct') assertConversationRecovery(content, store, mode === 'changed-config' ? 'test-v2' : 'test-v1', id, budget);
    result = await runner.resume(id);
  }
  await interactions.settled();
  writeFileSync(identityPath, rootId());
  process.stdout.write(JSON.stringify({ result, state: store.load(), handledProposals: handledProposals(), roots: store.checkpoints.listRoots().map((head) => ({ contextId: head.image.frame.owner.contextId, status: head.delivery?.status })) }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: { code: error?.code, message: error?.message }, state: store.load() }));
  process.exitCode = 1;
} finally {
  await interactions.settled();
  interactions.close();
  store.close();
}
