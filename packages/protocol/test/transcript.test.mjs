import assert from 'node:assert/strict';
import test from 'node:test';
import { Transcript } from '@weiliang0121/capix-transcript';
import { acceptTranscriptUpdate } from '@weiliang0121/capix-protocol';

const roundtrip = (value) => JSON.parse(JSON.stringify(value));
const baseline = (transcript) => ({ type: 'baseline', snapshot: { id: transcript.id, revision: transcript.revision, start: 0, end: transcript.length, starts: transcript.exportState().starts, messages: transcript.snapshot() } });

test('real transcript baselines and both delta variants survive JSON transport', () => {
  const events = [];
  const transcript = new Transcript([], {
    observation: {
      publish(event) {
        events.push(event);
      },
    },
  });
  assert.deepEqual(acceptTranscriptUpdate(roundtrip(baseline(transcript))), baseline(transcript));
  transcript.append({ role: 'user', content: 'one' }, { role: 'assistant', content: 'two' });
  transcript.startSegment(1);
  transcript.appendFrom([{ role: 'user', content: 'three' }], { origin: { contextId: 'actual-call' } });
  for (const event of events) assert.deepEqual(acceptTranscriptUpdate(roundtrip({ type: 'delta', event })), { type: 'delta', event });
  const wire = roundtrip(baseline(transcript));
  const fixed = acceptTranscriptUpdate(wire);
  wire.snapshot.messages[0].content = 'later';
  assert.equal(fixed.snapshot.messages[0].content, 'one');
  assert.ok(Object.isFrozen(fixed.snapshot.messages[0]));
  assert.deepEqual(fixed.snapshot.starts, [0, 1]);
});

test('single-frame admission does not claim stream continuity or restart authority', () => {
  const transcript = new Transcript([{ role: 'user', content: 'one' }]);
  const first = roundtrip(baseline(transcript));
  assert.deepEqual(acceptTranscriptUpdate(first), acceptTranscriptUpdate(first));
  assert.deepEqual(acceptTranscriptUpdate({ type: 'error', code: 'SOURCE_GONE', error: 'Unavailable' }), { type: 'error', code: 'SOURCE_GONE', error: 'Unavailable' });
  assert.equal(transcript.length, 1);
});

test('malformed envelopes, ranges, segments and unknown domain fields are rejected', () => {
  const transcript = new Transcript([
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'two' },
  ]);
  const valid = baseline(transcript);
  const bad = [
    { ...valid, taskId: 'host-only' },
    { ...valid, snapshot: { ...valid.snapshot, end: 3 } },
    { ...valid, snapshot: { ...valid.snapshot, start: 1 } },
    { ...valid, snapshot: { ...valid.snapshot, starts: [] } },
    { ...valid, snapshot: { ...valid.snapshot, starts: [0, 0] } },
    { ...valid, snapshot: { ...valid.snapshot, starts: [0, 2] } },
    { ...valid, snapshot: { ...valid.snapshot, revision: 0 } },
    { ...valid, snapshot: { ...valid.snapshot, revision: 3 } },
    { type: 'baseline', snapshot: { id: transcript.id, revision: 9, start: 0, end: 0, starts: [0], messages: [] } },
    {
      ...valid,
      snapshot: {
        ...valid.snapshot,
        messages: [
          { role: 'tool', content: 'one' },
          { role: 'user', content: 'two' },
        ],
      },
    },
    {
      ...valid,
      snapshot: {
        ...valid.snapshot,
        messages: [
          { role: 'user', content: 'one', topic: 'extra' },
          { role: 'user', content: 'two' },
        ],
      },
    },
    { type: 'error', code: 'UNKNOWN', error: '', retry: true },
  ];
  const event = { type: 'transcript', transcriptId: transcript.id, revision: 2, occurredAt: new Date().toISOString(), change: { kind: 'messages-appended', start: 2, messages: [] } };
  bad.push({ type: 'delta', event });
  bad.push({ type: 'delta', event: { ...event, change: { kind: 'segment-started', previousStart: 0, start: 2, end: 2 } } });
  bad.push({ type: 'delta', event: { ...event, change: { kind: 'segment-started', previousStart: 1, start: 1, end: 2 } } });
  for (const value of bad) assert.throws(() => acceptTranscriptUpdate(value));
  let invoked = false;
  assert.throws(() =>
    acceptTranscriptUpdate({
      get type() {
        invoked = true;
        return 'error';
      },
      code: 'X',
      error: 'bad',
    }),
  );
  assert.equal(invoked, false);
});
