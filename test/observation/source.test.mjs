import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChangeBuffer, Recorder, RecordBook, RecordingRootRecord } from '@capix/server-runtime';
import { ChangeConsumer, RecordSource, SourceIncomplete, initializeObserver, ObservationFeed } from '@capix/observer-service';
import { ClientRuntime, ObservationSequenceError } from '@capix/client-runtime';
import { transport } from '../client/fixtures.mjs';

const settle = () => new Promise((resolve) => setImmediate(resolve));
function fixture() {
  const changes = new ChangeBuffer();
  const recorder = new Recorder(new RecordBook(), { changes });
  const consumer = new ChangeConsumer(changes);
  const source = new RecordSource(recorder, consumer);
  const add = () => recorder.add(new RecordingRootRecord({ createdAt: new Date().toISOString() }));
  return { recorder, consumer, source, add };
}

test('source opening drains the old buffer and hands off fixed baseline plus exact later revisions', async () => {
  const { consumer, source, add } = fixture();
  try {
    const first = add();
    const events = [];
    const opened = source.open({ change: (event) => events.push(event), incomplete: () => assert.fail('healthy source') });
    assert.equal(opened.baseline.revision, 1);
    assert.deepEqual(
      opened.baseline.value.map((entry) => entry.data.id),
      [first.id],
    );
    const second = add();
    await settle();
    assert.deepEqual(
      events.map((event) => event.revision),
      [2],
    );
    assert.equal(events[0].value.change.entry.data.id, second.id);
    assert.equal(opened.baseline.value.length, 1);
    assert.ok(Object.isFrozen(opened.baseline.value));
    opened.close();
    add();
    await settle();
    assert.equal(events.length, 1);
  } finally {
    consumer.close();
  }
});

test('a source invalidated before its first subscriber never provides a healthy baseline', () => {
  const { consumer, source, add } = fixture();
  try {
    add();
    source.invalidate(new Error('a missing observation'));
    const receiver = { change: () => assert.fail(), incomplete: () => assert.fail('failed open has no subscription') };
    assert.throws(
      () => source.open(receiver),
      (error) => error instanceof SourceIncomplete && error.code === 'SOURCE_INCOMPLETE',
    );
    add();
    assert.throws(() => source.open(receiver), SourceIncomplete);
  } finally {
    consumer.close();
  }
});

test('source invalidation terminates each receiver once and never delivers later record changes', async () => {
  const { consumer, source, add } = fixture();
  try {
    const received = [];
    const opened = source.open({ change: (event) => received.push(event), incomplete: (error) => received.push(error.code) });
    add();
    source.invalidate(new Error('lost record'));
    source.invalidate(new Error('later failure'));
    await settle();
    assert.deepEqual(received, ['SOURCE_INCOMPLETE']);
    opened.close();
    assert.throws(() => source.open({ change() {}, incomplete() {} }), SourceIncomplete);
  } finally {
    consumer.close();
  }
});

test('closing a record source ends its receivers without invalidating facts or closing content consumption', () => {
  const { consumer, source, add } = fixture();
  const events = [];
  const consumed = [];
  consumer.subscribe((event) => consumed.push(event));
  const receiver = {
    change: () => events.push('change'),
    incomplete: () => assert.fail('normal closure is not missing evidence'),
    closed: () => events.push('closed'),
  };
  try {
    source.open(receiver);
    source.close();
    source.close();
    add();
    consumer.flush();
    assert.deepEqual(events, ['closed']);
    assert.equal(consumed.length, 1);
    assert.throws(() => source.open(receiver), /Record source is closed/);
  } finally {
    consumer.close();
  }
});

test('closing the record source also detaches the feed from supplementary content changes', async () => {
  const environment = initializeObserver({ invoke: () => assert.fail('no model required') });
  const feed = new ObservationFeed(environment);
  const frames = [];
  try {
    feed.connect((frame) => frames.push(frame));
    environment.records.source.close();
    environment.transcript.append({ role: 'user', content: 'content remains independent' });
    environment.consumer.flush();
    await settle();
    assert.deepEqual(
      frames.map((frame) => frame.type),
      ['baseline'],
    );
    assert.equal(environment.transcript.length, 1);
  } finally {
    feed.close();
    environment.close();
  }
});

test('record delivery discards queued healthy changes on invalidation while message delivery remains live', async () => {
  const environment = initializeObserver({ invoke: () => assert.fail('no model required') });
  const feed = new ObservationFeed(environment);
  const records = [];
  const messages = [];
  try {
    feed.connect((frame) => records.push(frame));
    environment.consumer.flush();
    environment.transcripts.connect((frame) => messages.push(frame));
    environment.transcript.append({ role: 'user', content: 'first' });
    environment.consumer.flush();
    environment.records.source.invalidate(new Error('record mapper failed'));
    await settle();
    assert.deepEqual(
      records.map((frame) => frame.type),
      ['baseline', 'error'],
    );
    assert.equal(records[1].code, 'SOURCE_INCOMPLETE');
    environment.transcript.append({ role: 'assistant', content: 'still authoritative' });
    await settle();
    assert.deepEqual(
      messages.map((frame) => frame.type),
      ['baseline', 'delta', 'delta'],
    );
    assert.throws(() => feed.connect(() => assert.fail()), SourceIncomplete);
    assert.equal(records.length, 2);
  } finally {
    feed.close();
    environment.consumer.close();
  }
});

test('an incomplete record source does not trigger client automatic baseline repair', async () => {
  let attempts = 0;
  const failure = Object.assign(new Error('source incomplete', { cause: new ObservationSequenceError('missing source fact') }), { code: 'SOURCE_INCOMPLETE' });
  const io = transport();
  const runtime = new ClientRuntime({
    conversation: io,
    transcripts: io,
    observation: {
      async observe() {
        attempts++;
        throw failure;
      },
    },
  });
  await runtime.initialize();
  const stop = runtime.startObservation();
  try {
    await settle();
    assert.equal(attempts, 1);
    assert.equal(runtime.getSnapshot().observation.error, failure);
    assert.equal(runtime.getSnapshot().observation.loading, false);
  } finally {
    stop();
    runtime.stopTranscript();
  }
});

test('opening during a receiver callback excludes the remainder of the old batch already represented by its baseline', () => {
  const { consumer, source, add } = fixture();
  let joined;
  const later = [];
  const first = source.open({
    change() {
      joined ??= source.open({ change: (event) => later.push(event), incomplete() {} });
    },
    incomplete() {},
  });
  try {
    add();
    add();
    consumer.flush();
    assert.equal(joined.baseline.revision, 2);
    assert.equal(joined.baseline.value.length, 2);
    assert.equal(later.length, 0);
    add();
    consumer.flush();
    assert.deepEqual(
      later.map((event) => event.revision),
      [3],
    );
  } finally {
    first.close();
    joined?.close();
    consumer.close();
  }
});

test('reentrant feed opening fixes all source watermarks and does not replay pending message events after its baseline', async () => {
  const environment = initializeObserver({ invoke: () => assert.fail('no model required') });
  const feed = new ObservationFeed(environment);
  environment.consumer.flush();
  let opened = false;
  const observations = [];
  const messages = [];
  const off = environment.consumer.subscribe((change) => {
    if (change.type !== 'transcript' || opened) return;
    opened = true;
    feed.connect((frame) => observations.push(frame));
    environment.consumer.flush();
    environment.transcripts.connect((frame) => messages.push(frame));
  });
  try {
    environment.transcript.append({ role: 'user', content: 'first' });
    environment.transcript.append({ role: 'assistant', content: 'second' });
    environment.consumer.flush();
    await settle();
    assert.deepEqual(
      observations.map((frame) => frame.type),
      ['baseline'],
    );
    assert.equal(observations[0].transcript.revision, 2);
    assert.deepEqual(
      messages.map((frame) => frame.type),
      ['baseline'],
    );
    assert.equal(messages[0].snapshot.revision, 2);
    environment.transcript.append({ role: 'user', content: 'next' });
    await settle();
    assert.deepEqual(
      observations.map((frame) => frame.type),
      ['baseline', 'delta'],
    );
    assert.deepEqual(
      messages.map((frame) => frame.type),
      ['baseline', 'delta'],
    );
    assert.equal(messages[1].event.revision, 3);
  } finally {
    off();
    feed.close();
    environment.consumer.close();
  }
});

test('closing observation leaves the independently connected transcript live', async () => {
  const environment = initializeObserver({ invoke: () => assert.fail('no model required') });
  const feed = new ObservationFeed(environment);
  const records = [];
  const messages = [];
  environment.consumer.flush();
  const disconnect = environment.transcripts.connect((frame) => messages.push(frame));
  try {
    feed.connect((frame) => records.push(frame));
    feed.close();
    environment.transcript.append({ role: 'user', content: 'independent content' });
    await settle();
    assert.deepEqual(
      records.map((frame) => frame.type),
      ['baseline'],
    );
    assert.deepEqual(
      messages.map((frame) => frame.type),
      ['baseline', 'delta'],
    );
    assert.equal(messages[1].event.change.messages[0].content, 'independent content');
  } finally {
    disconnect();
    feed.close();
    environment.consumer.close();
  }
});
