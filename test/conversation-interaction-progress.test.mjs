import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConversationScene, createInteractionAnswer, HistoryResource, ModelInteractionResource, TextModelInteraction } from '@capix/conversation-service';
import { Interactions } from '@capix/interaction';
import { Resource, Resources as ResourceRegistry, ResourceAccessClosed } from '@capix/resources';
import { Node, Resources, Runner, Scene } from '@capix/server-runtime';
import { Transcript, TranscriptResource } from '@capix/transcript';

const messages = [{ role: 'user', content: 'question' }];

function conversation(interactions, transcript = new Transcript(), waitMs = 1000) {
  const entity = new Resource(transcript);
  const resources = new Resources().register(entity, TranscriptResource.append).register(entity, HistoryResource).registerInteraction(ModelInteractionResource.start, TextModelInteraction).registerInteraction(ModelInteractionResource.feedback, TextModelInteraction);
  return new Runner(createConversationScene(createInteractionAnswer({ waitMs })), resources, interactions).build();
}

function follower(interactions, delta) {
  const node = new Node({
    deps: { feedback: ModelInteractionResource.feedback.request() },
    run: (work) => work.resources.feedback.follow(work.input, { delta }),
  });
  return new Runner(new Scene(node), new Resources().registerInteraction(ModelInteractionResource.feedback, TextModelInteraction), interactions).build();
}

function rawAccess(interactions) {
  const deps = { feedback: ModelInteractionResource.feedback.request() };
  const registry = new ResourceRegistry().register(new Resource(interactions.bind(TextModelInteraction)), ModelInteractionResource.feedback);
  return registry.bind(deps).open();
}

test('independent model progress published before reading is replayed through Group, Scene and Runner output', async () => {
  const deltas = [];
  const transcript = new Transcript();
  const interactions = new Interactions().register(TextModelInteraction, {
    send(_messages, { publish }) {
      publish('first');
      publish('');
      publish(' second');
      return 'corrected final';
    },
  });
  const runner = conversation(interactions, transcript);
  runner.output.subscribe({ receive: (event) => void (event.kind === 'delta' && deltas.push(event.delta)) });
  assert.equal(await runner.run('question'), 'corrected final');
  assert.deepEqual(deltas, ['first', '', ' second']);
  assert.deepEqual(transcript.snapshot(), [...messages, { role: 'assistant', content: 'corrected final' }]);
  await interactions.settled();
  interactions.close();
});

test('cancelling a follower stops its preview while late production and a new cursor-based reader continue', { timeout: 3000 }, async () => {
  const reply = Promise.withResolvers();
  const consumed = Promise.withResolvers();
  let sends = 0;
  let publisher;
  const interactions = new Interactions().register(TextModelInteraction, {
    send(_messages, controls) {
      sends++;
      publisher = controls;
      controls.publish('first');
      return reply.promise;
    },
  });
  const reference = interactions.bind(TextModelInteraction).start(messages);
  const oldItems = [];
  const runner = follower(interactions, (item) => {
    oldItems.push(item);
    consumed.resolve();
  });
  const run = runner.run({ reference, waitMs: 1000 });
  const stopped = assert.rejects(run, { code: 'INVOCATION_CANCELLED' });
  await consumed.promise;
  runner.cancel();
  await stopped;
  assert.equal(interactions.active, true);
  publisher.publish('second');
  publisher.publish('third');
  reply.resolve('final');
  await interactions.settled();
  const newItems = [];
  const result = await follower(interactions, (item) => newItems.push(item)).run({ reference, after: oldItems[0].cursor, waitMs: 1000 });
  assert.equal(result.kind, 'received');
  assert.equal(result.feedback.payload, 'final');
  assert.deepEqual(
    oldItems.map((item) => item.value),
    ['first'],
  );
  assert.deepEqual(
    newItems.map((item) => item.value),
    ['second', 'third'],
  );
  assert.deepEqual(
    newItems.map((item) => item.cursor.sequence),
    [2, 3],
  );
  assert.equal(sends, 1);
  interactions.close();
});

test('preview capacity loss and malformed preview do not replace independently valid final feedback', async (t) => {
  for (const reason of ['capacity', 'invalid-data']) {
    await t.test(reason, async () => {
      const transcript = new Transcript();
      const interactions = new Interactions().register(TextModelInteraction, {
        progress: { maxBytes: 16 },
        send(_messages, { publish }) {
          publish(reason === 'capacity' ? 'x'.repeat(100) : { text: 'not declared text' });
          return 'final answer';
        },
      });
      assert.equal(await conversation(interactions, transcript).run('question'), 'final answer');
      assert.deepEqual(transcript.snapshot(), [...messages, { role: 'assistant', content: 'final answer' }]);
      await interactions.settled();
      interactions.close();
    });
  }
});

test('sealed preview cannot turn invalid final feedback into an accepted answer', async () => {
  const transcript = new Transcript();
  const deltas = [];
  const interactions = new Interactions().register(TextModelInteraction, {
    send(_messages, { publish }) {
      publish('a complete looking answer');
      return '  ';
    },
  });
  const runner = conversation(interactions, transcript);
  runner.output.subscribe({ receive: (event) => void (event.kind === 'delta' && deltas.push(event.delta)) });
  await assert.rejects(runner.run('question'));
  assert.deepEqual(deltas, ['a complete looking answer']);
  assert.deepEqual(transcript.snapshot(), messages);
  await interactions.settled();
  interactions.close();
});

test('frequent progress does not renew the local wait budget', { timeout: 3000 }, async () => {
  const reply = Promise.withResolvers();
  let timer;
  const interactions = new Interactions().register(TextModelInteraction, {
    send(_messages, { publish }) {
      timer = setInterval(() => publish('tick'), 2);
      return reply.promise;
    },
  });
  const reference = interactions.bind(TextModelInteraction).start(messages);
  try {
    const result = await follower(interactions, () => {}).run({ reference, waitMs: 30 });
    assert.equal(result.kind, 'wait-expired');
    assert.equal(interactions.active, true);
  } finally {
    clearInterval(timer);
    reply.resolve('late result');
    await interactions.settled();
    interactions.close();
  }
});

for (const action of ['follow', 'wait']) {
  test(`closing a resource window wakes ${action} without cancelling the independent sender`, { timeout: 3000 }, async () => {
    const entered = Promise.withResolvers();
    const reply = Promise.withResolvers();
    const interactions = new Interactions().register(TextModelInteraction, {
      send() {
        entered.resolve();
        return reply.promise;
      },
    });
    const reference = interactions.bind(TextModelInteraction).start(messages);
    const access = rawAccess(interactions);
    const running = access.endpoints.feedback[action]({ reference, waitMs: 60_000 });
    const stopped = assert.rejects(running, (error) => error instanceof ResourceAccessClosed);
    await entered.promise;
    access.close();
    await stopped;
    assert.equal(interactions.active, true);
    reply.resolve('late answer');
    await interactions.settled();
    assert.equal(interactions.bind(TextModelInteraction).read(reference).kind, 'received');
    interactions.close();
  });
}

test('resource window closure also stops the final wait after preview has become unavailable', { timeout: 3000 }, async () => {
  const entered = Promise.withResolvers();
  const reply = Promise.withResolvers();
  const interactions = new Interactions().register(TextModelInteraction, {
    progress: { maxBytes: 1 },
    send(_messages, { publish }) {
      publish('too long');
      entered.resolve();
      return reply.promise;
    },
  });
  const reference = interactions.bind(TextModelInteraction).start(messages);
  const access = rawAccess(interactions);
  const running = access.endpoints.feedback.follow({ reference, waitMs: 60_000 });
  const stopped = assert.rejects(running, (error) => error instanceof ResourceAccessClosed);
  await entered.promise;
  // Allow the preview failure to be observed and the independent final wait to start.
  await new Promise((resolve) => setImmediate(resolve));
  access.close();
  await stopped;
  reply.resolve('final');
  await interactions.settled();
  interactions.close();
});

test('a cursor is delivery position even when a delta receiver fails; final feedback remains independent', async () => {
  const interactions = new Interactions().register(TextModelInteraction, {
    send(_messages, { publish }) {
      publish('first');
      publish('second');
      return 'final';
    },
  });
  const reference = interactions.bind(TextModelInteraction).start(messages);
  await interactions.settled();
  let offered;
  const final = await follower(interactions, (item) => {
    offered = item;
    throw new Error('viewer did not accept this item');
  }).run({ reference, waitMs: 1000 });
  assert.equal(final.kind, 'received');
  assert.equal(offered.cursor.sequence, 1);
  const replayed = [];
  await follower(interactions, (item) => replayed.push(item.value)).run({ reference, waitMs: 1000 });
  assert.deepEqual(replayed, ['first', 'second'], 'an unconfirmed delivery can be replayed from the original position');
  interactions.close();
});

test('one follow operation fixes its exchange identity across preview and final reading', async () => {
  let sends = 0;
  const interactions = new Interactions().register(TextModelInteraction, {
    send(_messages, { publish }) {
      const index = ++sends;
      publish(`preview ${index}`);
      return `answer ${index}`;
    },
  });
  const channel = interactions.bind(TextModelInteraction);
  const first = channel.start(messages);
  const second = channel.start(messages);
  await interactions.settled();
  const mutable = { ...first };
  const result = await follower(interactions, () => {
    mutable.id = second.id;
  }).run({ reference: mutable, waitMs: 1000 });
  assert.equal(result.kind, 'received');
  assert.equal(result.feedback.payload, 'answer 1');
  interactions.close();
});
