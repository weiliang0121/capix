import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { Scene, Node, checkpointPoint, childReference } from '@weiliang0121/capix-structure';
import { Runner, Resources } from '@weiliang0121/capix-runtime';
import { ChatCompletionsProvider } from '@weiliang0121/capix-model-provider';
import { CompletionInteraction } from '@capix/conversation-service';
import { loadConversationContent } from '@capix/conversation-service/assembly';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { createToolLoop, tool } from '@capix/conversation-service/tools';
import { ToolExchanges, createArchivedToolAnswer, registerArchivedToolResources, createToolConversationInteractions, readToolCheckpoint } from '@capix/conversation-service/tools/hosting';

const [mode, path] = process.argv.slice(2);
const store = ConversationStore.open(path);
const content = loadConversationContent(store);
const archive = new ToolExchanges({
  ...store.exchanges,
  load: (...args) => store.exchanges.load(...args),
  list: (...args) => store.exchanges.list(...args),
  commit: (...args) => store.exchanges.commit(...args),
  initialize(...args) {
    store.exchanges.initialize(...args);
    if (mode === 'crash-initialized') stop('initialized');
  },
});
let requests = 0;
const provider = new ChatCompletionsProvider({
  endpoint: 'https://fixture.invalid/chat/completions',
  apiKey: 'offline-fixture',
  model: 'fixture',
  fetch: async (_url, options) => {
    requests++;
    const request = JSON.parse(options.body);
    const calls = request.messages.some((message) => message.role === 'tool') ? undefined : [{ id: 'echo-1', type: 'function', function: { name: 'echo', arguments: '{}' } }];
    return new Response(JSON.stringify({ id: `reply-${requests}`, model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: calls ? null : 'done', ...(calls ? { tool_calls: calls } : {}) }, finish_reason: calls ? 'tool_calls' : 'stop' }] }));
  },
});
const text = { encode: (value) => z.string().parse(value), decode: (value) => z.string().parse(value) };
const nil = { encode: () => null, decode: () => null };
const empty = { encode: (value) => z.strictObject({}).parse(value), decode: (value) => z.strictObject({}).parse(value) };
const done = checkpointPoint()({ name: 'done', state: text, references: {}, resume: { run: (_work, value) => value } });
const echo = new Node({
  checkpoint: { key: 'fixture.archived-echo', version: 1, input: empty, output: text, points: [done] },
  run(work) {
    const value = 'small result';
    work.checkpoint({ point: done, state: value, refs: {} });
    return value;
  },
});
const loop = createToolLoop({ checkpoint: true, policyVersion: 'fixture.archive-v1', tools: { echo: tool(echo, { description: 'Return a small result.', input: z.strictObject({}), maxOutputBytes: 128, result: { succeeded: (text) => ({ status: 'ok', content: [{ kind: 'text', text }] }) } }) } });
const answer = createArchivedToolAnswer(loop);
const interactions = createToolConversationInteractions(provider, store.interactions, loop.budgets);
const waiting = checkpointPoint()({ name: 'waiting', state: nil, references: { answer: childReference(answer) }, resume: { uses: [answer], run: (work, _state, refs) => work.children.resume(refs.answer).invoke() } });
const scene = new Scene({ checkpoint: { key: 'fixture.archived-scene', version: 1, input: text, output: text, points: [waiting] } }).add({ answer });
scene.run = (work) => {
  const index = content.transcript.length;
  content.transcript.append({ role: 'user', content: work.input });
  const input = { query: { transcriptId: content.transcript.id, index, content: work.input }, materials: { basis: { viewRevision: 0, sources: { messages: { id: content.transcript.id, scope: 'whole', version: String(index + 1) }, memories: { id: content.memories.id, scope: 'whole', version: '0' } } }, entries: [] } };
  const child = work.children.create(answer, input);
  work.checkpoint({ point: waiting, state: null, refs: { answer: child.ref } });
  return child.invoke();
};
const resources = new Resources();
registerArchivedToolResources(resources, answer, loop, interactions.bind(CompletionInteraction), provider.inspectRequest.bind(provider), store.interactions);
const measurements = [];
const checkpoints = {
  read: (id) => readToolCheckpoint(store.checkpoints, id),
  save(image, revision) {
    const start = performance.now();
    const receipt = store.checkpoints.save(image, revision);
    const elapsedMs = performance.now() - start;
    image = store.checkpoints.read(image.frame.owner.contextId).image;
    measurements.push({ kind: 'save', key: image.contract.key, point: image.point, bytes: Buffer.byteLength(JSON.stringify(image)), syncMs: elapsedMs, children: image.frame.children.length });
    if (image.contract.key === 'conversation.tools.archived-answer' && mode === `crash-${image.point}`) stop(image.point);
    return receipt;
  },
  finish(id, revision, delivery) {
    const start = performance.now();
    const receipt = store.checkpoints.finish(id, revision, delivery);
    measurements.push({ kind: 'finish', bytes: Buffer.byteLength(JSON.stringify(delivery)), syncMs: performance.now() - start });
    return receipt;
  },
};
function report(extra) {
  return { ...extra, requests, collections: store.exchanges.list(), loaded: archive.loadedCount, usage: store.archiveUsage(), measurements };
}
function stop(point) {
  console.log(JSON.stringify(report({ point })));
  process.exit(73);
}
const runner = new Runner(scene, resources, interactions, { checkpoints: { store: checkpoints } }).build();
async function invoke(resume) {
  const use = archive.openUse();
  try {
    return resume ? await runner.resume(store.checkpoints.listRoots().find((head) => !head.delivery).image.frame.owner.contextId, { exchangeUse: use }) : await runner.run('hello', { exchangeUse: use });
  } finally {
    use.close();
  }
}
try {
  const result = await invoke(mode === 'resume');
  if (mode === 'twice') await invoke(false);
  console.log(JSON.stringify(report({ result })));
} catch (error) {
  console.log(JSON.stringify(report({ failure: error.message, code: error.code })));
  process.exitCode = 1;
} finally {
  await interactions.settled();
  interactions.close();
  store.close();
}
