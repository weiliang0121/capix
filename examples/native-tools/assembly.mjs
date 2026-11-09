import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Resource } from '@weiliang0121/capix-resources';
import { Resources, Runner } from '@weiliang0121/capix-runtime';
import { Interactions } from '@weiliang0121/capix-interaction';
import { acceptReply } from './protocol.mjs';
import { finalReply, toolReply } from './fixtures.mjs';
import { ExchangeResource, ModelExchanges } from './exchanges.mjs';
import { CheckpointJournal, InteractionJournal } from './measurement.mjs';
import { ModelContract, LoopModelResource, createToolScene } from './structure.mjs';
import { ToolResource, createFileTools, toolEntries, toolCatalog } from './tools.mjs';
import { fixed, collectionLimit } from './value.mjs';

export function defaultCatalog(policyVersion = 1) {
  return toolCatalog(toolEntries(createFileTools(() => {})), policyVersion);
}

export function offlineReply(request) {
  const step = request.messages.filter((message) => message.role === 'assistant').length;
  if (step === 0)
    return toolReply(
      [
        { id: 'read-1', name: 'read_text', arguments: JSON.stringify({ path: 'notes.md' }) },
        { id: 'read-2', name: 'read_text', arguments: JSON.stringify({ path: 'missing.md' }) },
        { id: 'unknown', name: 'not_registered', arguments: '{}' },
      ],
      { id: 'model-0', content: 'Reading the sources.' },
    );
  if (step === 1) return toolReply([{ id: 'write-1', name: 'save_text', arguments: JSON.stringify({ path: 'summary.md', text: 'translated' }) }], { id: 'model-1' });
  return finalReply('Translation saved.', 'model-final');
}

/** New structure instances and new resource windows, including during restoration. */
export function createHarness({ catalog: suppliedCatalog, policyVersion = suppliedCatalog?.snapshot.policyVersion ?? 1, tools = createFileTools, checkpoints = new CheckpointJournal(), snapshot, model = offlineReply, maxModelCalls = 8, waitMs = 5000, toolSource, captureInput = (input) => input, retainSnapshots = true, exchanges: sharedExchanges } = {}) {
  if (snapshot && sharedExchanges) throw new TypeError('Choose a restored or a shared exchange entity');
  const exchanges = sharedExchanges ?? (snapshot ? ModelExchanges.restore(snapshot.exchanges) : new ModelExchanges());
  const persistence = snapshot ? InteractionJournal.restore(snapshot.interactions) : new InteractionJournal();
  const files = toolSource ?? { files: new Map(snapshot?.files ?? [['notes.md', 'hello']]), reads: snapshot?.reads ?? 0, writes: snapshot?.writes ?? 0 };
  const requests = [];
  const interactions = new Interactions().register(ModelContract, {
    persistence,
    async send(request) {
      requests.push(fixed(request));
      return acceptReply(await model(request));
    },
  });
  const channel = interactions.bind(ModelContract);
  const write = (work, value) => {
    const start = performance.now();
    work.checkpoint(value);
    const sample = checkpoints.samples.at(-1);
    if (sample?.kind === 'save') sample.writerMs = performance.now() - start;
  };
  const { scene, loop, catalog } = createToolScene(tools(write), { policyVersion, catalog: suppliedCatalog, maxModelCalls, waitMs, write });
  const resources = new Resources().register(new Resource(files), ToolResource);
  resources
    .capture(loop, (input) => {
      if (input.catalog !== catalog.digest) throw new Error('Tool catalog changed before capture');
      return fixed(captureInput(input));
    })
    .register(ExchangeResource, (input) => ({ exchanges, scope: input.scope }))
    .register(LoopModelResource, (input) => ({ channel, input, exchanges, catalog }));
  const runner = new Runner(scene, resources, interactions, { checkpoints: { store: checkpoints } }).build();
  const snapshotNow = () => fixed({ exchanges: exchanges.snapshot(), interactions: persistence.snapshot(), files: [...files.files], reads: files.reads, writes: files.writes }, collectionLimit);
  checkpoints.capture = retainSnapshots ? snapshotNow : () => undefined;
  const feedbackCuts = [];
  persistence.committed = (state) => {
    if (retainSnapshots && state.feedback) feedbackCuts.push({ writeCount: checkpoints.writes.length, snapshot: snapshotNow() });
  };
  return {
    runner,
    interactions,
    exchanges,
    files,
    requests,
    checkpoints,
    persistence,
    catalog,
    feedbackCuts,
    input(materials = 'Translate notes.md and save a summary.') {
      return fixed({ scope: randomUUID(), materials, catalog: catalog.digest, maxModelCalls, waitMs });
    },
    snapshot: snapshotNow,
    async close() {
      await interactions.settled();
      interactions.close();
    },
  };
}
