import assert from 'node:assert/strict';

import { test } from 'node:test';

import { ProgressChannel } from '@weiliang0121/capix-changes';

import { Transcript } from '@weiliang0121/capix-transcript';

const message = (content) => ({ role: 'user', content });

test('transcript commit progress survives strict capture failure and never contains message bodies', () => {
  const facts = [];
  const transcript = new Transcript([], {
    changes: {
      capture() {
        throw new Error('capture failed after commit');
      },
    },
  });
  const progress = new ProgressChannel({
    receive(fact) {
      facts.push(fact);
      assert.equal(transcript.length, 2);
      assert.equal(transcript.revision, 1);
    },
  });
  assert.throws(() => transcript.appendFrom([message('one'), message('two')], { progress }), /capture/i);
  assert.deepEqual(facts, [{ transcriptId: transcript.id, start: 0, end: 2, revision: 1 }]);
  assert.ok(Object.isFrozen(facts[0]));
  assert.equal(transcript.length, 2);
});

test('transcript progress cannot reenter mutation and does not undo or duplicate the append', () => {
  const transcript = new Transcript();
  const progress = new ProgressChannel({
    receive() {
      transcript.append(message('reentrant'));
    },
  });
  transcript.appendFrom([message('committed')], { progress });
  assert.equal(transcript.length, 1);
  assert.equal(transcript.get(0).content, 'committed');
  assert.match(progress.failure.error.message, /reenter/);
  transcript.appendFrom([message('next')], { progress });
  assert.equal(transcript.length, 2);
});
