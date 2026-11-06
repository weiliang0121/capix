import { appendFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { Scene, Node, checkpointPoint, childReference } from '@capix/structure';
import { Resource, ResourceOffer } from '@capix/resources';
import { Runner, Resources } from '@capix/server-runtime';
import { ChatCompletionsProvider } from '@capix/model-provider';
import { ModelExchanges } from '@capix/model-exchanges';
import { CompletionInteraction } from '@capix/conversation-service';
import { loadConversationContent, createConversationInteractions, createYieldingFetch } from '@capix/conversation-service/assembly';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { createToolLoop, registerToolLoopResources, tool, toolLoopInputCodec } from '@capix/conversation-service/tools';

const [mode, path, endpoint, effects] = process.argv.slice(2);
const store = ConversationStore.open(path);
const content = loadConversationContent(store);
const archived = store.exchanges.list({ limit: 1 }).items[0];
const saved = archived ? store.exchanges.load(archived.id) : undefined;
if (saved && !saved.metadata) throw new Error('Fixture cannot resume an unanchored archive');
const exchanges = saved ? ModelExchanges.restore(saved.state, { limits: saved.metadata.limits, persistence: store.exchanges }) : new ModelExchanges({ persistence: store.exchanges });
if (!saved) store.exchanges.initialize(exchanges.snapshot(), { source: { transcriptId: content.transcript.id, index: 0 }, scope: 'fixture-scope', policy: { version: 1, name: 'fixture-tools' }, limits: { entries: 10_000, bytes: 64 * 1024 * 1024 } });
const provider = new ChatCompletionsProvider({ endpoint, apiKey: 'local-test-only', model: 'fixture', fetch: createYieldingFetch(), timeoutMs: 10000 });
const interactions = createConversationInteractions(provider, store.interactions);
const text = { encode: (value) => z.string().parse(value), decode: (value) => z.string().parse(value) };
const nil = { encode: () => null, decode: () => null };
const input = z.strictObject({ text: z.string() });
const Effect = new ResourceOffer({
  methods: {
    save(file, value) {
      appendFileSync(file, JSON.stringify(value) + '\n');
      return value.text.toUpperCase();
    },
  },
});
const done = checkpointPoint()({ name: 'done', state: text, references: {}, resume: { run: (_work, value) => value } });
const save = new Node({
  deps: { effect: Effect.request() },
  checkpoint: { key: 'fixture.tool.save', version: 1, input: { encode: (v) => input.parse(v), decode: (v) => input.parse(v) }, output: text, points: [done] },
  async run(work) {
    const result = await work.resources.effect.save(work.input);
    work.checkpoint({ point: done, state: result, refs: {} });
    return result;
  },
});
const loop = createToolLoop({ tools: { save: tool(save, { description: 'Save text and return its uppercase value.', input, result: { succeeded: (value) => ({ status: 'ok', content: [{ kind: 'text', text: value }] }) } }) }, policyVersion: 'fixture-tools-v1', checkpoint: true, maxModelCalls: 8 });
const waiting = checkpointPoint()({ name: 'waiting', state: nil, references: { loop: childReference(loop) }, resume: { uses: [loop], run: (work, _state, refs) => work.children.resume(refs.loop).invoke() } });
const scene = new Scene({ checkpoint: { key: 'fixture.tools.scene', version: 1, input: toolLoopInputCodec, output: text, points: [waiting] } }).add({ loop });
scene.run = (work) => {
  const child = work.children.create(loop, work.input);
  work.checkpoint({ point: waiting, state: null, refs: { loop: child.ref } });
  return child.invoke();
};
const resources = new Resources().register(new Resource(effects), Effect);
registerToolLoopResources(resources, loop, exchanges, interactions.bind(CompletionInteraction), store.interactions);
const measurements = [];
const checkpointStore = {
  read: (id) => store.checkpoints.read(id),
  save(image, revision) {
    if (mode === 'crash-model' && image.contract.key === 'conversation.tools.completion' && image.point === 'completed') {
      console.log(JSON.stringify({ status: 'crashed', measurements }));
      process.exit(73);
    }
    const start = performance.now();
    const result = store.checkpoints.save(image, revision);
    measurements.push({ kind: 'save', contract: image.contract.key, point: image.point, bytes: Buffer.byteLength(JSON.stringify(image)), syncMs: performance.now() - start, children: image.frame.children.length, modelInput: image.contract.key === 'conversation.tools.completion' ? image.frame.input : undefined });
    if (mode === 'crash' && image.contract.key === 'conversation.tools.loop' && image.point === 'tools' && image.state.cursor === 1) {
      console.log(JSON.stringify({ status: 'crashed', measurements }));
      process.exit(73);
    }
    return result;
  },
  finish(id, revision, delivery) {
    const start = performance.now();
    const result = store.checkpoints.finish(id, revision, delivery);
    measurements.push({ kind: 'finish', bytes: Buffer.byteLength(JSON.stringify(delivery)), syncMs: performance.now() - start });
    return result;
  },
};
const runner = new Runner(scene, resources, interactions, { checkpoints: { store: checkpointStore } }).build();
try {
  const result = mode === 'resume' ? await runner.resume(store.checkpoints.listRoots().find((root) => !root.delivery).image.frame.owner.contextId) : await runner.run(loop.input({ messages: [{ role: 'user', content: 'basis-' + 'x'.repeat(4096) }], maxTokens: 512 }, 'fixture-scope', exchanges.id));
  await interactions.settled();
  console.log(JSON.stringify({ status: 'completed', result, measurements, exchanges: exchanges.snapshot(), roots: store.checkpoints.listRoots().map((root) => root.delivery?.status) }));
} catch (error) {
  console.log(JSON.stringify({ status: 'failed', code: error.code, name: error.name }));
  process.exitCode = 1;
} finally {
  await interactions.settled();
  interactions.close();
  store.close();
}
