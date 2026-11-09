import { writeSync } from 'node:fs';
import { Resource, ResourceOffer } from '@weiliang0121/capix-resources';
import { Scene, checkpointPoint } from '@weiliang0121/capix-structure';
import { Resources, Runner } from '@weiliang0121/capix-runtime';
import { ConversationStore } from '@capix/conversation-service/persistence';

// An actual saved, unfinished root is reopened by a different process. No copied
// completed head, private construction API, or synthetic recovery receipt.
const [mode, path, policy = 'business'] = process.argv.slice(2);
if (!['run', 'cut', 'resume'].includes(mode) || !['business', 'resource', 'none'].includes(policy)) throw new Error('Invalid observation probe arguments');
const store = ConversationStore.open(path);
const codec = { encode: structuredClone, decode: structuredClone };
const key = 'study.recovery.business-observation';
const events = [];
const counts = { boundObservers: 0, body: 0, business: 0, businessReturned: 0, resourceBody: 0, resourceReturned: 0, caught: 0 };
const offer = new ResourceOffer({
  methods: {
    read() {
      counts.resourceBody++;
      return 'value';
    },
  },
});
const deps = { probe: offer.request() };
async function body(work) {
  counts.body++;
  try {
    work.observation({ event: 'required-business' });
    counts.businessReturned++;
    const value = await work.resources.probe.read();
    counts.resourceReturned++;
    return value;
  } catch (error) {
    counts.caught++;
    events.push({ source: 'body', kind: 'caught', code: error.code, message: error.message });
    // A required mechanism failure must still fail the call after a business catch.
    return 'fallback must not survive';
  }
}
const ready = checkpointPoint()({ name: 'ready', state: codec, references: {}, resume: { deps, run: body } });
const scene = new Scene({
  deps,
  checkpoint: { key, version: 1, input: codec, output: codec, points: [ready] },
  run(work) {
    work.checkpoint({ point: ready, state: null, refs: {} });
    if (mode === 'cut') {
      print({ status: 'cut-after-save' });
      process.exit(73); // Deliberately bypass Invocation cleanup and all finally blocks.
    }
    return body(work);
  },
});
const runner = new Runner(scene, new Resources().register(new Resource(null), offer), undefined, {
  observations: [
    {
      failure: 'propagate',
      bindInvocation() {
        counts.boundObservers++;
        return {
          observe() {},
          business(fact) {
            counts.business++;
            events.push({ source: 'strict-business', kind: fact.event.event });
            if (policy === 'business') throw new Error('required business observation failed');
          },
        };
      },
    },
  ],
  checkpoints: {
    store: store.checkpoints,
    observation: {
      failure: 'propagate',
      observe(fact) {
        events.push({ source: 'strict-checkpoint', kind: fact.kind, detail: fact.fact?.kind ?? fact.fact?.phase, recovering: fact.recovering });
        if (policy === 'resource' && fact.recovering && fact.kind === 'resource' && fact.fact.phase === 'returned') throw new Error('required recovery resource observation failed');
      },
    },
  },
}).build();
runner.observation.subscribe({
  receive(event) {
    events.push({ source: `passive-${event.source}`, kind: event.fact.kind ?? event.fact.event, detail: event.fact.fact?.kind ?? event.fact.fact?.phase });
  },
});
function print(result) {
  const head = store.checkpoints.listRoots().find((item) => item.image.contract.key === key);
  writeSync(1, `${JSON.stringify({ pid: process.pid, mode, policy, ...result, counts, events, head: head ? { contextId: head.image.frame.owner.contextId, point: head.image.point, revision: head.revision, delivery: head.delivery ?? null } : null, running: runner.isRunning })}\n`);
}
try {
  const root = store.checkpoints.listRoots().find((item) => item.image.contract.key === key);
  const output = mode === 'resume' ? await runner.resume(root.image.frame.owner.contextId) : await runner.run(null);
  print({ status: 'succeeded', output });
} catch (error) {
  print({ status: 'failed', error: { name: error.name, code: error.code, message: error.message, cause: error.cause?.message } });
} finally {
  store.close();
}
