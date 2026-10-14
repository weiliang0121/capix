import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChangeBuffer, ProgressChannel } from '@capix/server-runtime';
import { Transcript } from '@capix/server-runtime/content';

function request(transcript, content = 'fixed answer', position = 'answer-message') {
  return { contract: { key: 'transcript.append', version: 1 }, operation: { parentContextId: 'parent', childContextId: 'child', position }, transcriptId: transcript.id, messages: [{ role: 'assistant', content }] };
}

test('fixed append returns its original location without repeating content, revision, persistence or publication', () => {
  const changes = new ChangeBuffer();
  const writes = [];
  const progress = [];
  const transcript = new Transcript([], {
    changes,
    persistence: {
      commit(change) {
        writes.push(change);
      },
    },
  });
  const input = request(transcript);
  const options = {
    progress: new ProgressChannel({
      receive(value) {
        progress.push(value);
      },
    }),
  };
  assert.equal(transcript.confirmFixed(input), undefined);
  const receipt = transcript.applyFixed(input, options);
  assert.deepEqual(receipt, { transcriptId: transcript.id, start: 0, count: 1, revision: 1 });
  assert.ok(Object.isFrozen(receipt));
  assert.deepEqual(writes[0].fixed, { request: input, receipt });
  assert.ok(Object.isFrozen(writes[0].fixed.request.operation));
  transcript.append({ role: 'user', content: 'later input' });
  const before = transcript.exportState();
  assert.equal(transcript.confirmFixed(input), receipt);
  assert.equal(transcript.applyFixed(JSON.parse(JSON.stringify(input)), options), receipt);
  assert.deepEqual(transcript.exportState(), before);
  assert.equal(writes.length, 2);
  assert.equal(changes.size, 2);
  assert.equal(progress.length, 1);
  input.messages[0].content = 'tampered caller';
  input.operation.position = 'different';
  assert.equal(writes[0].fixed.request.messages[0].content, 'fixed answer');
  assert.equal(writes[0].fixed.request.operation.position, 'answer-message');
});

test('fixed append rejects changed content, target or effect contract and preserves the original result', () => {
  const transcript = new Transcript();
  const input = request(transcript);
  transcript.applyFixed(input);
  const before = transcript.exportState();
  const conflicts = [request(transcript, 'different'), { ...input, transcriptId: 'different' }, { ...input, contract: { key: 'transcript.append', version: 2 } }, { ...input, contract: { key: 'other', version: 1 } }, { ...input, messages: [{ role: 'user', content: 'fixed answer' }] }];
  for (const value of conflicts) {
    assert.throws(() => transcript.applyFixed(value), { code: 'TRANSCRIPT_APPEND_CONFLICT' });
    assert.throws(() => transcript.confirmFixed(value), { code: 'TRANSCRIPT_APPEND_CONFLICT' });
    assert.deepEqual(transcript.exportState(), before);
  }
  assert.throws(() => transcript.applyFixed({ ...input, messages: [] }), /Invalid fixed/);
  const next = transcript.applyFixed(request(transcript, 'fixed answer', 'independent-effect'));
  assert.equal(next.start, 1, 'equal text from a distinct operation remains a distinct effect');
});

test('fixed operation becomes confirmable before post-commit change failure and never republishes the failed change', () => {
  const writes = [];
  let captures = 0;
  const failure = new Error('capture unavailable');
  const transcript = new Transcript([], {
    persistence: {
      commit(change) {
        writes.push(change);
      },
    },
    changes: {
      capture() {
        captures++;
        throw failure;
      },
    },
  });
  const input = request(transcript);
  assert.throws(
    () => transcript.applyFixed(input),
    (error) => error.code === 'CHANGE_CAPTURE_FAILED' && error.cause === failure,
  );
  assert.equal(transcript.length, 1);
  assert.equal(transcript.confirmFixed(input).start, 0);
  assert.equal(transcript.applyFixed(input).revision, 1);
  assert.equal(captures, 1);
  assert.equal(writes.length, 1);
});

test('fixed append persistence failure installs neither the message nor operation receipt', () => {
  let shouldFail = true;
  let transcript;
  transcript = new Transcript([], {
    persistence: {
      commit(change) {
        assert.throws(() => transcript.applyFixed(request(transcript)), /reenter/);
        assert.equal(transcript.confirmFixed(change.fixed.request), undefined);
        if (shouldFail) throw new Error('disk full');
      },
    },
  });
  const input = request(transcript);
  assert.throws(() => transcript.applyFixed(input), /disk full/);
  assert.equal(transcript.length, 0);
  assert.equal(transcript.confirmFixed(input), undefined);
  shouldFail = false;
  assert.equal(transcript.applyFixed(input).start, 0);
});

test('restored fixed append validates the original content and receipt and consumes it silently', () => {
  const original = new Transcript([{ role: 'user', content: 'input' }]);
  const input = request(original);
  const receipt = original.applyFixed(input);
  original.append({ role: 'user', content: 'later' });
  const saved = JSON.parse(JSON.stringify(original.exportState()));
  const changes = new ChangeBuffer();
  const restored = Transcript.restore(saved, {
    changes,
    persistence: {
      commit() {
        assert.fail('reuse must not persist');
      },
    },
  });
  assert.deepEqual(restored.applyFixed(input), receipt);
  assert.equal(restored.length, 3);
  assert.equal(changes.size, 0);
  saved.appends[0].request.messages[0].content = 'outside edit';
  assert.deepEqual(restored.confirmFixed(input), receipt);
  for (const mutate of [
    (state) => {
      state.appends[0].request.messages[0].content = 'wrong original';
    },
    (state) => {
      state.appends[0].receipt.start = 0;
    },
    (state) => {
      state.appends[0].receipt.revision = 999;
    },
    (state) => {
      state.appends[0].receipt.count = 2;
    },
    (state) => {
      state.appends.push(state.appends[0]);
    },
  ]) {
    const bad = JSON.parse(JSON.stringify(original.exportState()));
    mutate(bad);
    assert.throws(() => Transcript.restore(bad));
  }
});
