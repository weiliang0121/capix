import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineObservation } from '@capix/server-runtime';
import { ObserverConversations, SqliteObserverStore, createObserverServer } from '@capix/observer-service';
import { ObservationHttpTransport } from '@capix/client-http';
import { withRuntimeDefinition } from '../fixtures/assembly.mjs';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 512, timeoutMs: 2000 };
const output = (value) => ({ id: 'provider-feedback', model: 'fixture', content: JSON.stringify(value), finishReason: 'stop', usage: null });
function deferred() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
async function setup(t, provider, options = {}, configureDefinition) {
  const conversations = new ObserverConversations(provider, [], options);
  const id = conversations.list().defaultConversationId;
  const observer = withRuntimeDefinition(configureDefinition, () => conversations.open(id));
  const server = createObserverServer({ conversations, settings, configured: true });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await observer.interactions.settled();
    conversations.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { conversations, observer, id, base, transport: new ObservationHttpTransport(base) };
}

test('A1 and A2 link the same interaction; pending call return, live external feedback and parent acceptance remain distinct', async (t) => {
  const answer = deferred();
  t.after(() => answer.resolve(output({ kind: 'answer', content: 'cleanup' })));
  const pending = deferred();
  let sends = 0;
  const { conversations, observer, id, base, transport } = await setup(
    t,
    {
      async invoke(_request, purpose) {
        if (purpose === 'selection') return output({ historyIndexes: [] });
        if (purpose === 'memory') return output({ memories: [] });
        sends += 1;
        return answer.promise;
      },
    },
    {},
    (definition) => {
      const model = definition.taskDefinition.operationDefinitions.generation.requestModelDefinition;
      model.observation = [
        ...model.observation,
        defineObservation({
          requires: {},
          observe(fact) {
            if (fact.kind === 'relation' && fact.change.kind === 'returned' && fact.change.result.status === 'succeeded' && fact.change.result.output.kind === 'pending') pending.resolve();
          },
        }),
      ];
    },
  );
  const running = observer.driver.run(observer.scene, { messages: [{ role: 'user', content: 'sensitive prompt never in metadata' }] }, { settings });
  // Avoid depending on network or provider timing: wait for the actual local A1 deadline fact.
  await pending.promise;
  const interaction = observer.interactions.states().find((state) => state.request.purpose === 'answer');
  const create = [...observer.book.values()].find((record) => record.kind === 'resource' && record.access === 'model-interaction.create' && record.phase === 'returned' && record.value.output?.id === interaction.id);
  assert.ok(create);
  const callId = create.parentId;
  const ref = create.value.output.id;
  const links = await transport.interactions(id, callId);
  assert.deepEqual(links, { callId, interactionIds: [ref] });
  const states = [];
  await transport.observeInteraction(
    id,
    callId,
    ref,
    (state) => {
      states.push(state);
      if (state.result.kind === 'pending') answer.resolve(output({ kind: 'answer', content: 'sensitive reply never in metadata' }));
    },
    new AbortController().signal,
  );
  await running;
  assert.deepEqual(
    states.map((state) => state.result.kind),
    ['pending', 'received'],
  );
  assert.equal(sends, 1);
  assert.equal(states.at(-1).retained, 'memory');
  assert.doesNotMatch(JSON.stringify(states), /sensitive|messages|content|prompt|usage/);
  const readers = [...observer.book.values()].filter((record) => record.kind === 'resource' && record.access === 'model-interaction.read' && record.phase === 'started' && record.value.action === 'result');
  assert.ok(readers.length);
  assert.deepEqual((await transport.interactions(id, readers.find((record) => record.value.input.id === ref).parentId)).interactionIds, [ref]);
  const fresh = conversations.create();
  const denied = await fetch(`${base}/api/interactions?conversationId=${fresh.id}&callId=${callId}`);
  assert.notEqual(denied.status, 200);
  assert.equal((await denied.json()).code, 'CALL_NOT_FOUND');
  const unlinked = await fetch(`${base}/api/interaction/observe?conversationId=${id}&callId=${callId}&id=other`);
  assert.notEqual(unlinked.status, 200);
  assert.equal((await unlinked.json()).code, 'INTERACTION_NOT_FOUND');
  const root = [...observer.book.values()].find((record) => record.kind === 'runtime');
  const rootResponse = await fetch(`${base}/api/interactions?conversationId=${id}&callId=${root.id}`);
  assert.equal((await rootResponse.json()).code, 'CALL_NOT_FOUND');
  const runtime = [...observer.book.values()].find((record) => record.kind === 'invocation' && record.structureKind === 'scene');
  assert.deepEqual((await transport.interactions(id, runtime.id)).interactionIds, []);
});

test('saved interaction metadata is read through restored call links without constructing a provider', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'capix-observed-interaction-'));
  const path = join(directory, 'observer.sqlite');
  const original = new ObserverConversations(
    {
      async invoke(_request, purpose) {
        return output(purpose === 'selection' ? { historyIndexes: [] } : purpose === 'memory' ? { memories: [] } : { kind: 'answer', content: 'saved answer' });
      },
    },
    [],
    { persistence: SqliteObserverStore.open(path) },
  );
  const firstId = original.list().defaultConversationId;
  const environment = original.open(firstId);
  await environment.driver.run(environment.scene, { messages: [{ role: 'user', content: 'saved request' }] }, { settings });
  const resource = [...environment.book.values()].find((record) => record.kind === 'resource' && record.access === 'model-interaction.create' && record.phase === 'returned');
  const ref = resource.value.output.id;
  const callId = resource.parentId;
  original.close();
  let constructions = 0;
  const { id, transport } = await setup(
    t,
    () => {
      constructions += 1;
      throw new Error('observation must not construct providers');
    },
    { persistence: SqliteObserverStore.open(path) },
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.equal(id, firstId);
  assert.deepEqual((await transport.interactions(id, callId)).interactionIds, [ref]);
  const values = [];
  await transport.observeInteraction(id, callId, ref, (value) => values.push(value), new AbortController().signal);
  assert.equal(values.length, 1);
  assert.equal(values[0].retained, 'persistent');
  assert.equal(values[0].result.kind, 'received');
  assert.equal(constructions, 0);
});
