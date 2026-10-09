import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindDelivery, SourceIncomplete } from '../../services/observer/dist/observation/delivery.js';

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A small value source; no records, runtime, or inheritance. */
function source() {
  let revision = 0;
  let value = 0;
  let failure;
  const receivers = new Set();
  return {
    get subscriptions() {
      return receivers.size;
    },
    open(receiver) {
      if (failure) throw failure;
      const baseline = Object.freeze({ sourceId: 'counter', revision, value });
      receivers.add(receiver);
      return { baseline, close: () => receivers.delete(receiver) };
    },
    add(amount) {
      value += amount;
      const change = Object.freeze({ revision: ++revision, value: Object.freeze({ amount, value }) });
      for (const receiver of receivers) receiver.change(change);
    },
    invalidate() {
      if (failure) return;
      failure = new SourceIncomplete('counter', 'Counter source is incomplete');
      const targets = [...receivers];
      receivers.clear();
      for (const receiver of targets) receiver.incomplete(failure);
    },
  };
}
function options(frames, overrides = {}) {
  return {
    baseline: (baseline) => ({ type: 'baseline', ...baseline }),
    delta: (changes) => ({ type: 'delta', changes }),
    incomplete: (error) => ({ type: 'error', code: error.code }),
    error: () => ({ type: 'error', code: 'PROJECTION_FAILED' }),
    send: (frame) => frames.push(frame),
    ...overrides,
  };
}

test('a structural non-record source delegates baseline, queue-only batching, and closing', async () => {
  const counter = source();
  counter.add(2);
  const frames = [];
  let projections = 0;
  const delivery = bindDelivery(
    counter,
    options(frames, {
      delta(changes) {
        projections++;
        return { type: 'delta', changes };
      },
    }),
  );
  assert.equal(frames[0].value, 2);
  assert.equal(frames[0].revision, 1);
  counter.add(3);
  counter.add(4);
  assert.equal(projections, 0);
  assert.equal(frames.length, 1);
  await settle();
  assert.equal(projections, 1);
  assert.deepEqual(
    frames[1].changes.map((change) => change.value),
    [5, 9],
  );
  delivery.close();
  delivery.close();
  assert.equal(counter.subscriptions, 0);
  counter.add(1);
  await settle();
  assert.equal(frames.length, 2);
});

test('invalidation during baseline projection suppresses that healthy baseline and is delivered once', async () => {
  const counter = source();
  const frames = [];
  const delivery = bindDelivery(
    counter,
    options(frames, {
      baseline() {
        counter.invalidate();
        return { type: 'baseline' };
      },
    }),
  );
  assert.deepEqual(frames, []);
  counter.invalidate();
  await settle();
  assert.deepEqual(frames, [{ type: 'error', code: 'SOURCE_INCOMPLETE' }]);
  assert.equal(delivery.closed, true);
  assert.equal(counter.subscriptions, 0);
  assert.throws(() => bindDelivery(counter, options([])), SourceIncomplete);
});

test('source invalidation preempts pending deltas and extra-source changes', async () => {
  const counter = source();
  const frames = [];
  let sink;
  let detached = 0;
  const delivery = bindDelivery(
    counter,
    options(frames, {
      attach(value) {
        sink = value;
        return () => {
          detached++;
        };
      },
    }),
  );
  counter.add(1);
  sink.enqueue({ amount: 4, value: 5 });
  counter.invalidate();
  sink.enqueue({ amount: 8, value: 13 });
  await settle();
  assert.deepEqual(
    frames.map((frame) => frame.type),
    ['baseline', 'error'],
  );
  assert.equal(frames[1].code, 'SOURCE_INCOMPLETE');
  assert.equal(delivery.closed, true);
  assert.equal(detached, 1);
});

test('ordinary projection and sender failures close only their own delivery', async () => {
  const counter = source();
  const frames = [];
  const failed = bindDelivery(
    counter,
    options([], {
      delta() {
        throw new Error('bad projection');
      },
    }),
  );
  const other = bindDelivery(counter, options(frames));
  counter.add(1);
  await settle();
  assert.equal(failed.closed, true);
  assert.equal(other.closed, false);
  assert.deepEqual(
    frames.map((frame) => frame.type),
    ['baseline', 'delta'],
  );
  const badSender = bindDelivery(
    counter,
    options([], {
      send() {
        throw new Error('connection closed');
      },
    }),
  );
  assert.equal(badSender.closed, true);
  const reconnect = bindDelivery(counter, options([]));
  assert.equal(reconnect.closed, false);
  assert.equal(counter.subscriptions, 2);
  reconnect.close();
  other.close();
});

test('a close during supplementary attachment releases its late returned subscription', () => {
  const counter = source();
  let detached = 0;
  const delivery = bindDelivery(
    counter,
    options([], {
      attach(sink) {
        sink.close();
        return () => {
          detached++;
        };
      },
      baseline: () => assert.fail('closed before baseline'),
    }),
  );
  assert.equal(delivery.closed, true);
  assert.equal(counter.subscriptions, 0);
  assert.equal(detached, 1);
  delivery.close();
  assert.equal(detached, 1);
});

test('delta projection invalidation wins over its projected frame and control failure stays connection-local', async () => {
  const counter = source();
  const frames = [];
  const delivery = bindDelivery(
    counter,
    options(frames, {
      delta() {
        counter.invalidate();
        return { type: 'delta' };
      },
      incomplete() {
        throw new Error('control projection failed');
      },
    }),
  );
  counter.add(1);
  await settle();
  assert.deepEqual(
    frames.map((frame) => frame.type),
    ['baseline'],
  );
  assert.equal(delivery.closed, true);
  assert.equal(counter.subscriptions, 0);
});

test('synchronous open and baseline projection errors keep their original failure identity', () => {
  const failure = new Error('cannot open');
  assert.throws(
    () =>
      bindDelivery(
        {
          open() {
            throw failure;
          },
        },
        options([]),
      ),
    (error) => error === failure,
  );
  const counter = source();
  let detached = false;
  assert.throws(
    () =>
      bindDelivery(
        counter,
        options([], {
          attach: () => () => {
            detached = true;
          },
          baseline() {
            throw failure;
          },
        }),
      ),
    (error) => error === failure,
  );
  assert.equal(counter.subscriptions, 0);
  assert.equal(detached, true);
  const healthy = bindDelivery(counter, options([]));
  healthy.close();
});

for (const failure of ['incomplete', 'error']) {
  test(`${failure} control projection failure cannot escape the scheduled delivery`, async () => {
    const counter = source();
    const frames = [];
    const delivery = bindDelivery(
      counter,
      options(frames, {
        delta() {
          throw new Error('delta cannot be projected');
        },
        [failure]() {
          throw new Error('control cannot be projected');
        },
      }),
    );
    counter.add(1);
    if (failure === 'incomplete') counter.invalidate();
    await settle();
    assert.equal(delivery.closed, true);
    assert.equal(counter.subscriptions, 0);
    assert.deepEqual(
      frames.map((frame) => frame.type),
      ['baseline'],
    );
    if (failure === 'error') {
      const replacement = bindDelivery(counter, options([]));
      assert.equal(replacement.closed, false);
      replacement.close();
    }
  });
}
