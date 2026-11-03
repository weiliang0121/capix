import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConversationScene, HistoryResource } from '@capix/conversation-service';
import { Resource } from '@capix/resources';
import { Group, Node, Resources, Runner } from '@capix/server-runtime';
import { Transcript, TranscriptResource } from '@capix/transcript';

function build(scene, transcript) {
  const entity = new Resource(transcript);
  // A custom answer needs only the dependencies it declares; no model resource is implicit.
  const resources = new Resources().register(entity, TranscriptResource.append).register(entity, HistoryResource);
  return new Runner(scene, resources).build();
}

for (const kind of ['node', 'group']) {
  test(`a custom ${kind} replaces the answer without CompletionResource and receives the complete accepted prefix`, async () => {
    const requests = [];
    const node = new Node({
      run(work) {
        requests.push(work.input);
        assert.ok(Object.isFrozen(work.input));
        assert.ok(work.input.every(Object.isFrozen));
        return `custom answer ${requests.length}`;
      },
    });
    let answer = node;
    if (kind === 'group') {
      answer = new Group().add({ node });
      answer.run = (work) => work.children.node.invoke(work.input);
    }
    const earlier = [
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
    ];
    const transcript = new Transcript(earlier);
    const runner = build(createConversationScene(answer), transcript);
    assert.equal(await runner.run('first'), 'custom answer 1');
    assert.equal(await runner.run('second'), 'custom answer 2');
    assert.deepEqual(requests, [
      [...earlier, { role: 'user', content: 'first' }],
      [...earlier, { role: 'user', content: 'first' }, { role: 'assistant', content: 'custom answer 1' }, { role: 'user', content: 'second' }],
    ]);
    assert.deepEqual(transcript.snapshot(), [...requests[1], { role: 'assistant', content: 'custom answer 2' }]);
  });
}

for (const [label, value] of [
  ['blank text', ' \n\t'],
  ['an object', { content: 'not text' }],
]) {
  test(`Scene rejects ${label} from an unchecked custom answer before attempting assistant append`, async () => {
    const attempts = [];
    class CheckedTranscript extends Transcript {
      appendFrom(messages, provenance) {
        if (messages.length) attempts.push(messages);
        super.appendFrom(messages, provenance);
      }
    }
    const transcript = new CheckedTranscript();
    const answer = new Node({ run: () => value });
    assert.equal(answer.output, undefined);
    const runner = build(createConversationScene(answer), transcript);
    const events = [];
    runner.output.subscribe({ receive: (event) => void events.push(event) });

    await assert.rejects(runner.run('question'));
    assert.deepEqual(attempts, [[{ role: 'user', content: 'question' }]], 'the Scene checks accepted text before calling the entity writer');
    assert.deepEqual(transcript.snapshot(), [{ role: 'user', content: 'question' }]);
    assert.equal(
      events.some((event) => event.kind === 'completed'),
      false,
    );
    assert.equal(runner.isRunning, false);
  });
}

test('one answer structure cannot be shared between two conversation scenes', async () => {
  const answer = new Node({ run: () => 'answer' });
  const first = createConversationScene(answer);
  assert.throws(() => createConversationScene(answer));
  const transcript = new Transcript();
  assert.equal(await build(first, transcript).run('question'), 'answer');
  assert.deepEqual(transcript.snapshot(), [
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'answer' },
  ]);
});
