import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Transcript, TranscriptRangeRef, TranscriptRangeReader, TranscriptResource } from '@weiliang0121/capix-transcript';
import { groupAdjacentPairs } from '@weiliang0121/capix-transcript/presets';
import { Resource } from '@weiliang0121/capix-resources';
import { Node, Scene } from '@weiliang0121/capix-structure';
import { Resources, Runner } from '@weiliang0121/capix-runtime';

const messages = (...roles) => roles.map((role, index) => ({ role, content: `message ${index}` }));
const indexes = (groups) => groups.map((group) => group.map((entry) => entry.index));
const entries = (transcript) => transcript.snapshot().map((message, index) => ({ index, message }));

test('the message preset groups adjacent pairs without claiming turns or changing official content', () => {
  const transcript = new Transcript(messages('assistant', 'user', 'user', 'assistant', 'assistant', 'user'));
  const before = transcript.exportState();
  const input = entries(transcript);
  const groups = groupAdjacentPairs(input);
  assert.deepEqual(indexes(groups), [[0], [1], [2, 3], [4], [5]]);
  assert.deepEqual(
    groups.flat().map((entry) => entry.index),
    input.map((entry) => entry.index),
  );
  for (const entry of groups.flat()) assert.equal(entry.message, transcript.get(entry.index));
  assert.ok(Object.isFrozen(groups));
  assert.ok(groups.every((group) => Object.isFrozen(group) && group.every(Object.isFrozen)));
  assert.deepEqual(transcript.exportState(), before);
  assert.deepEqual(groupAdjacentPairs([]), []);
});

test('view omissions do not make originally distant messages into an adjacent pair', () => {
  const transcript = new Transcript(messages('user', 'user', 'assistant', 'assistant', 'user', 'assistant'));
  const selected = entries(transcript).filter((entry) => [0, 2, 4, 5].includes(entry.index));
  assert.deepEqual(indexes(groupAdjacentPairs(selected)), [[0], [2], [4, 5]]);
  assert.deepEqual(indexes(groupAdjacentPairs([selected[0]])), [[0]]);
});

test('grouping rejects ambiguous ordering and invalid indexes instead of silently sorting or dropping messages', () => {
  const message = { role: 'user', content: 'input' };
  for (const positions of [[1, 1], [2, 1], [-1], [0.5], [NaN], [Infinity]]) assert.throws(() => groupAdjacentPairs(positions.map((index) => ({ index, message }))), /increasing nonnegative indexes/);
  assert.throws(() => groupAdjacentPairs([{ index: 0, message: { role: 'system', content: 'not a formal message' } }]), /user or assistant/);
  assert.throws(() => groupAdjacentPairs({}), /indexed messages/);
});

test('a normal policy node can use the preset with an explicit message resource and no entity writes', async () => {
  const transcript = new Transcript(messages('user', 'assistant', 'user'));
  const before = transcript.exportState();
  const group = new Node({
    deps: { messages: TranscriptResource.fixedRange.request() },
    run: (work) => groupAdjacentPairs(work.resources.messages.entries()),
  });
  const resources = new Resources().register(new Resource(new TranscriptRangeRef(transcript, 0, transcript.length)), TranscriptResource.fixedRange);
  const runner = new Runner(new Scene(group), resources).build();
  assert.deepEqual(indexes(await runner.run(undefined)), [[0, 1], [2]]);
  assert.deepEqual(transcript.exportState(), before);
});

test('the service chooses its retention limit and never treats grouping as an automatic segment write', async () => {
  const { segmentCandidates } = await import('@capix/observer-service');
  const transcript = new Transcript(messages('user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user'));
  const before = transcript.exportState();
  const range = new TranscriptRangeReader(new TranscriptRangeRef(transcript, 0, transcript.length));
  assert.deepEqual(
    segmentCandidates(range).map((candidate) => candidate.start),
    [2, 4, 6],
  );
  assert.deepEqual(
    segmentCandidates(range.slice(3)).map((candidate) => candidate.start),
    [4, 6],
  );
  assert.deepEqual(segmentCandidates(range.slice(6)), []);
  assert.deepEqual(segmentCandidates(range.slice(7)), []);
  assert.deepEqual(transcript.exportState(), before);
});

test('the optional preset is available separately from the entity root', async () => {
  const root = await import('@weiliang0121/capix-transcript');
  assert.equal('groupAdjacentPairs' in root, false);
  assert.equal(typeof groupAdjacentPairs, 'function');
});
