import assert from 'node:assert/strict';
import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';
import { Resource, ResourceOffer, Resources } from '@weiliang0121/capix-resources';
import { StableValues } from './stable.mjs';
import { createBoundaryCall } from './action-boundaries.mjs';
import { lifecycleBinding } from './invocation-lifecycle.mjs';

// Deterministic operation counts, not wall-clock performance. This retains the
// ACTUAL Frame-v5 hot path. Fixed handoffs are explicit fixture choices only.
export async function measureActionCost({ children, draftEdits = 0, resource = false, checkpoints = true }) {
  const counters = { parentInputEncode: 0, parentInputDecode: 0, childInputEncode: 0, childInputDecode: 0, childOutputEncode: 0, childOutputDecode: 0, receptionEncode: 0, receptionDecode: 0, receptionCheck: 0, oldOutputEncode: 0, oldReceptionCheck: 0, authorCheck: 0 };
  const stable = new StableValues();
  const samples = [];
  const memory = new MemoryCheckpointStore();
  const store = checkpoints ? memory : undefined;
  const origin = { operations: 0 };
  const offer = new ResourceOffer({
    methods: {
      read(source, step) {
        source.operations++;
        return { step, text: 'constant result' };
      },
    },
  });
  const resources = new Resources().register(new Resource(origin), offer);
  const binding = resources.bind({ source: offer.request() });
  const access = binding.open();
  let saving = false;
  let current = 0;
  let privateEdits = 0;
  let bodyVisitsInSaves = 0;
  let parentCapturedChildren = 0;
  const increment = (name) => {
    if (saving) counters[name]++;
  };
  const codec = (name) => ({
    encode(value) {
      increment(`${name}Encode`);
      if (saving && name === 'childOutput' && value.step < current) counters.oldOutputEncode++;
      return value;
    },
    decode(value) {
      increment(`${name}Decode`);
      return value;
    },
  });
  const childBinding = { ...lifecycleBinding('study.cost.child'), input: codec('childInput'), output: codec('childOutput') };
  const reception = {
    position: 0,
    childPosition: 0,
    codec: codec('reception'),
    check(value) {
      increment('receptionCheck');
      if (saving && value.step < current) counters.oldReceptionCheck++;
    },
  };
  const parentBinding = { ...lifecycleBinding('study.cost.parent', { children: [{ kind: 'node', binding: childBinding }], receptions: [reception] }), input: codec('parentInput') };
  parentBinding.points.checkpoint.check = () => increment('authorCheck');
  function save(invocation, phase) {
    if (!checkpoints) return;
    const before = { ...counters };
    const beforeVisits = stable.visits;
    saving = true;
    try {
      const image = invocation.checkpointWriter.save('checkpoint', { step: current, phase });
      parentCapturedChildren += image.frame.children.length;
      // Size measurement is outside any timing claim; previous images are not
      // retained. These are logical v5 bytes, not physical disk writes.
      samples.push({ step: current, phase, relations: image.frame.children.length, bytes: Buffer.byteLength(JSON.stringify(image)), counts: Object.fromEntries(Object.entries(counters).map(([key, value]) => [key, value - before[key]])) });
    } finally {
      saving = false;
      bodyVisitsInSaves += stable.visits - beforeVisits;
    }
  }
  try {
    const parent = createBoundaryCall({
      input: stable.own({ material: 'h'.repeat(1024) }),
      store,
      binding: parentBinding,
      async execute(_context, invocation) {
        for (current = 1; current <= children; current++) {
          const child = createBoundaryCall({
            parent: invocation,
            input: stable.own({ step: current }),
            store,
            binding: childBinding,
            async execute(context, childInvocation) {
              if (checkpoints) childInvocation.checkpointWriter.save('checkpoint', { step: context.input.step });
              const result = resource ? await access.endpoints.source.read(context.input.step) : { step: context.input.step, text: 'constant result' };
              return stable.own(result);
            },
          });
          save(invocation, 'waiting');
          await child.run();
          await invocation.children.get(child).accept((value) => {
            const draft = { step: value.step, text: value.text, scratch: 0 };
            for (let edit = 0; edit < draftEdits; edit++) {
              draft.scratch++;
              privateEdits++;
            }
            return stable.own({ step: draft.step, text: draft.text });
          }, reception);
          save(invocation, 'accepted');
        }
        return stable.own({ count: children });
      },
    });
    assert.deepEqual(await parent.run(), { count: children });
    return { config: { children, draftEdits, resource, checkpoints }, parentSaves: samples.length, parentCapturedChildren, privateEdits, resourceOperations: origin.operations, fixing: { visits: stable.visits, reused: stable.reused, bodyVisitsInSaves }, counts: { ...counters }, lastAccepted: samples.filter((sample) => sample.phase === 'accepted').at(-1) ?? null, samples };
  } finally {
    access.close();
  }
}
