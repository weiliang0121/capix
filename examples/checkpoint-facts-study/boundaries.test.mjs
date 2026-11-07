import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Invocation, InvocationContext } from '@capix/invocation';
import { Resources as ResourceRegistry, Resource, ResourceOffer, ResourceAccessClosed } from '@capix/resources';
import { Scene, Runner, Resources } from '@capix/server-runtime';
import { FixedData } from './model.mjs';

// Host-side experimental ownership, not an installed kernel policy.
test('real Runner: fixing input before run keeps capture and execution on one basis', async () => {
  async function probe(isolate) {
    const raw = { path: 'first.txt' };
    let capturedInput;
    let executingInput;
    const offer = new ResourceOffer({ expose: (value) => value });
    const scene = new Scene({
      deps: { selection: offer.request() },
      run(work) {
        executingInput = work.input;
        return { captured: work.resources.selection, executing: work.input.path };
      },
    });
    const resources = new Resources();
    resources
      .capture(scene, (input) => {
        capturedInput = input;
        const selection = input.path;
        // A host callback can still retain and change the caller's alias.
        raw.path = 'second.txt';
        return selection;
      })
      .register(offer, (selection) => selection);
    const runner = new Runner(scene, resources).build();
    const input = isolate ? new FixedData().own(raw) : raw;
    const result = await runner.run(input);
    assert.equal(capturedInput, executingInput);
    return result;
  }
  assert.deepEqual(await probe(false), { captured: 'first.txt', executing: 'second.txt' });
  assert.deepEqual(await probe(true), { captured: 'first.txt', executing: 'first.txt' });
});

// Two clocks: immutable candidate content, then a fallible final delivery.
// This sketch does not implement Invocation cancellation/observation/CP ordering.
async function deliverySketch(raw, { early, observed, gate, close = () => {} }) {
  const fixed = new FixedData();
  const candidate = early ? fixed.own(raw) : raw;
  observed.resolve(candidate);
  await gate.promise;
  close();
  return { status: 'succeeded', value: early ? candidate : fixed.own(raw) };
}

test('candidate fixed only after waiting incorporates intervening alias changes', async () => {
  for (const early of [false, true]) {
    const raw = { text: 'received from producer' };
    const observed = Promise.withResolvers();
    const gate = Promise.withResolvers();
    const running = deliverySketch(raw, { early, observed, gate });
    await observed.promise;
    raw.text = 'changed during wait';
    gate.resolve();
    const delivered = await running;
    assert.equal(delivered.value.text, early ? 'received from producer' : 'changed during wait');
  }
});

test('fixed candidate content does not authorize successful delivery when closing fails', async () => {
  const observed = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const failure = new Error('close failed');
  let successfulDeliveries = 0;
  const running = deliverySketch(
    { text: 'candidate' },
    {
      early: true,
      observed,
      gate,
      close: () => {
        throw failure;
      },
    },
  );
  const outcome = running.then(
    (value) => {
      successfulDeliveries++;
      return value;
    },
    (error) => ({ status: 'failed', error }),
  );
  const candidate = await observed.promise;
  assert.equal(candidate.text, 'candidate');
  gate.resolve();
  assert.equal((await outcome).error, failure);
  assert.equal(successfulDeliveries, 0);
});

test('await receiver cannot capture the producer lexical return instant', async () => {
  for (const asynchronous of [false, true]) {
    const raw = { value: 1 };
    const produce = () => {
      queueMicrotask(() => {
        raw.value = 2;
      });
      return raw;
    };
    const producer = asynchronous ? async () => produce() : produce;
    const received = await producer();
    const fixed = new FixedData().own(received);
    assert.equal(fixed.value, 2);
    raw.value = 3;
    assert.equal(fixed.value, 2);
  }
});

test('producer can publish an owned value before returning if it needs an earlier fixed meaning', async () => {
  const fixed = new FixedData();
  const raw = { value: 1 };
  async function producer() {
    const published = fixed.own(raw);
    queueMicrotask(() => {
      raw.value = 2;
    });
    return published;
  }
  const value = await producer();
  assert.equal(value.value, 1);
  assert.equal(raw.value, 2);
  const visits = fixed.visits;
  assert.equal(fixed.own(value), value);
  assert.equal(fixed.visits, visits);
});

test('real reception: side effects remain if the following value check/fixing rejects', async () => {
  const fixed = new FixedData();
  const signal = new AbortController().signal;
  const parentContext = new InvocationContext(null);
  let relation;
  let effects = 0;
  const parent = new Invocation({
    context: parentContext,
    signal,
    identity: { contextId: parentContext.id, kind: 'group' },
    work: {
      async execute(_context, invocation) {
        const childContext = new InvocationContext(null);
        const child = new Invocation({
          context: childContext,
          signal,
          identity: { contextId: childContext.id, parentContextId: parentContext.id, kind: 'node' },
          parent: { invocation, declarationPosition: 0 },
          work: { execute: () => 'child result' },
        });
        await child.run();
        relation = invocation.children.get(child);
        return relation.accept(
          () => {
            effects++;
            return new Date(0); // Outside this experiment's plain-data boundary.
          },
          {
            position: 0,
            childPosition: 0,
            check: (value) => {
              fixed.own(value);
            },
            codec: { encode: (value) => value, decode: (value) => value },
          },
        );
      },
    },
  });
  await assert.rejects(parent.run(), /Parent reception value violates its contract/);
  assert.equal(effects, 1);
  assert.equal(relation.returned.status, 'succeeded');
  assert.equal(relation.reception.status, 'failed');
});

test('frozen Date/Map and cloned custom classes do not supply transparent immutable T', () => {
  const date = Object.freeze(new Date('2020-01-01T00:00:00.000Z'));
  date.setUTCFullYear(2030);
  assert.equal(date.getUTCFullYear(), 2030);
  const map = Object.freeze(new Map([['x', 1]]));
  map.set('x', 2);
  assert.equal(map.get('x'), 2);
  class Counter {
    constructor() {
      this.value = 1;
    }
    read() {
      return this.value;
    }
  }
  const cloned = structuredClone(new Counter());
  assert.equal(cloned instanceof Counter, false);
  assert.equal(cloned.read, undefined);
});

test('rich value alternative: stable representation and editable workspace have different contracts', () => {
  const fixed = new FixedData();
  const original = new Date('2020-01-01T00:00:00.000Z');
  const value = fixed.own({ epochMs: original.getTime() });
  const draft = new Date(value.epochMs);
  draft.setUTCFullYear(2030);
  original.setUTCFullYear(2040);
  assert.equal(new Date(value.epochMs).getUTCFullYear(), 2020);
  assert.equal(draft.getUTCFullYear(), 2030);
  // Draft is explicitly NOT the immutable invocation input or the returned fact.
});

test('rich value alternative: a deliberately immutable type differs from a frozen live view', () => {
  class Instant {
    #epochMs;
    constructor(date) {
      this.#epochMs = date.getTime();
      Object.freeze(this);
    }
    year() {
      return new Date(this.#epochMs).getUTCFullYear();
    }
  }
  const source = new Date('2020-01-01T00:00:00.000Z');
  const instant = new Instant(source);
  const liveView = Object.freeze({ year: () => source.getUTCFullYear() });
  source.setUTCFullYear(2040);
  assert.equal(instant.year(), 2020);
  assert.equal(liveView.year(), 2040);
  // General code cannot infer these semantics from Object.isFrozen or methods.
});

test('real resource: stable locator/value does not preserve access after the operation window closes', async () => {
  const offer = new ResourceOffer({ methods: { read: (source) => source.text } });
  const access = new ResourceRegistry()
    .register(new Resource({ text: 'material' }), offer)
    .bind({ file: offer.request() })
    .open();
  const endpoint = access.endpoints.file;
  let fixed;
  try {
    fixed = new FixedData().own({ resourceId: 'file-1', text: await endpoint.read() });
  } finally {
    access.close();
  }
  assert.equal(fixed.text, 'material');
  await assert.rejects(endpoint.read(), ResourceAccessClosed);
  // Restoring resourceId cannot manufacture a new grant or reopen this endpoint.
});

test('encoding reuse is scoped by fixed value AND encoding contract, not value identity alone', () => {
  const value = new FixedData().own({ amount: 7 });
  let encodes = 0;
  const numberContract = Object.freeze({
    key: 'number@1',
    encode: (input) => {
      encodes++;
      return input.amount;
    },
  });
  const textContract = Object.freeze({
    key: 'text@1',
    encode: (input) => {
      encodes++;
      return String(input.amount);
    },
  });
  const cache = new WeakMap();
  const encode = (fixed, contract) => {
    let representations = cache.get(fixed);
    if (!representations) cache.set(fixed, (representations = new Map()));
    if (!representations.has(contract)) representations.set(contract, contract.encode(fixed));
    return representations.get(contract);
  };
  assert.equal(encode(value, numberContract), 7);
  assert.equal(encode(value, textContract), '7');
  assert.equal(encode(value, numberContract), 7);
  assert.equal(encodes, 2);
  // Requires deterministic, fixed contracts; arbitrary stateful codecs remain unresolved.
});
