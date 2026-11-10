import assert from 'node:assert/strict';

import { test } from 'node:test';

import { PersistenceError } from '@weiliang0121/capix-diagnostics';

import { Resource } from '@weiliang0121/capix-resources';

import { Node, Resources, Runner, Scene } from '@weiliang0121/capix-runtime';

import { Transcript, TranscriptResource } from '@weiliang0121/capix-transcript';

function writerWithParentFallback(failure) {
  let attempts = 0;
  const transcript = new Transcript([], {
    persistence: {
      commit() {
        attempts++;
        throw failure;
      },
    },
  });
  const writer = new Node({
    deps: { messages: TranscriptResource.append.request() },
    run(work) {
      work.resources.messages.append([{ role: 'assistant', content: 'not committed' }]);
      return 'saved';
    },
  });
  const scene = new Scene().add({ writer });
  const failures = [];
  scene.run = (work) =>
    work.children.writer.invoke(null, {
      result: {
        failed(error) {
          failures.push(error);
          return 'parent fallback';
        },
      },
    });
  const resources = new Resources().register(new Resource(transcript), TranscriptResource.append);
  const runner = new Runner(scene, resources).build();
  return { runner, transcript, failures, attempts: () => attempts };
}

test('an untyped Transcript persistence error cannot reach a parent business fallback', async () => {
  const failure = new Error('storage unavailable before commit');
  const fixture = writerWithParentFallback(failure);

  await assert.rejects(fixture.runner.run(null), (error) => error instanceof PersistenceError && error.operation === 'transcript.commit' && error.cause === failure);
  assert.deepEqual(fixture.failures, []);
  assert.equal(fixture.attempts(), 1);
  assert.deepEqual(fixture.transcript.snapshot(), []);
  assert.equal(fixture.transcript.revision, 0);
  assert.equal(fixture.runner.isRunning, false);
});

test('an adapter-typed Transcript PersistenceError keeps its identity and cannot be consumed by a parent fallback', async () => {
  const failure = new PersistenceError('transcript.commit', new Error('storage unavailable before commit'));
  const fixture = writerWithParentFallback(failure);

  await assert.rejects(fixture.runner.run(null), (error) => error === failure);
  assert.deepEqual(fixture.failures, []);
  assert.equal(fixture.attempts(), 1);
  assert.deepEqual(fixture.transcript.snapshot(), []);
  assert.equal(fixture.transcript.revision, 0);
  assert.equal(fixture.runner.isRunning, false);
});
