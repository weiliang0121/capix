import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CheckpointObservation } from '@capix/observer-service/observation';
import { ObserverConversations } from '@capix/observer-service/assembly';

const conversationId = 'conversation';
const roots = new Set(['root', 'other']);
const runs = { read: (conversation, rootContextId) => (conversation === conversationId && roots.has(rootContextId) ? { conversationId, rootContextId } : undefined) };
const owner = { contextId: 'root', level: 'runtime' };
function fact(detail = {}, changes = {}) {
  return { kind: 'saved', checkpointId: 'checkpoint', point: 'waiting', activityId: 'original', contextId: owner.contextId, owner, recovering: false, sequence: 1, occurredAt: '2026-10-14T00:00:00.000Z', ...detail, ...changes };
}

test('checkpoint source separates original and restored activities and does not retain their IO', () => {
  const source = new CheckpointObservation(conversationId, runs);
  source.observe(fact());
  const child = { identity: { contextId: 'execution', parentContextId: 'root', level: 'execution' }, round: 1, order: 0, key: 'work', state: { kind: 'returned', reception: { kind: 'accepted' } } };
  Object.defineProperty(child, 'input', { get: () => assert.fail('must not read saved input') });
  Object.defineProperty(child.state, 'output', { get: () => assert.fail('must not read saved output') });
  const frame = { owner, round: 1, nextChildOrder: 1, children: [child] };
  Object.defineProperty(frame, 'input', { get: () => assert.fail('must not read frame input') });
  source.observe(fact({ kind: 'installed', frame }, { activityId: 'restored', recovering: true }));
  source.observe(fact({ kind: 'resource', fact: { access: 'model.read', supplyId: 'supply', sequence: 1, phase: 'returned', describe: () => assert.fail('metadata never describes resource data') } }, { activityId: 'restored', recovering: true, sequence: 2 }));
  const state = source.query('root');
  assert.equal(state.activities.length, 2);
  assert.deepEqual(
    state.activities.map((activity) => activity.recovering),
    [false, true],
  );
  assert.equal(state.activities[1].installed.children[0].state, 'returned');
  assert.equal(state.activities[1].installed.children[0].reception, 'accepted');
  const encoded = JSON.stringify(state);
  assert.ok(!encoded.includes('"input"'));
  assert.ok(!encoded.includes('"output"'));
  assert.ok(!encoded.includes('"describe"'));
  assert.ok(encoded.length < 5000);
});

test('host checkpoint subscriptions filter actual ancestry and publish outside the producer', async () => {
  const source = new CheckpointObservation(conversationId, runs);
  const updates = [];
  const close = source.subscribe('root', (update) => updates.push(update));
  source.observe(fact({}, { activityId: 'other', contextId: 'other', owner: { contextId: 'other', level: 'runtime' } }));
  source.observe(fact());
  source.observe(fact({}, { activityId: 'execution', contextId: 'execution', owner: { contextId: 'execution', parentContextId: 'root', level: 'execution' } }));
  source.observe(fact({}, { activityId: 'operation', contextId: 'operation', owner: { contextId: 'operation', parentContextId: 'execution', level: 'operation' } }));
  assert.equal(updates.length, 1, 'only the requested baseline is synchronous');
  await Promise.resolve();
  assert.equal(updates.length, 2);
  assert.deepEqual(
    updates[1].events.map((event) => event.contextId),
    ['root', 'execution', 'operation'],
  );
  assert.ok(updates[1].events.every((event) => event.rootContextId === 'root'));
  assert.equal(source.query('other').events.length, 1);
  assert.throws(() => source.query('unregistered'), { code: 'CHECKPOINT_NOT_FOUND' });
  close();
  source.observe(fact({}, { sequence: 2 }));
  await Promise.resolve();
  assert.equal(updates.length, 2);
  source.close();
  assert.throws(() => source.query('root'), { code: 'CHECKPOINT_OBSERVATION_CLOSED' });
});

test('checkpoint metadata retention is bounded and overflow explicitly resets the subscription baseline', async () => {
  const source = new CheckpointObservation(conversationId, runs, { events: 2, activities: 2, owners: 4, children: 1 });
  const updates = [];
  source.subscribe('root', (update) => updates.push(update));
  for (let sequence = 1; sequence <= 5; sequence++) source.observe(fact({}, { activityId: `activity-${sequence}`, sequence }));
  await Promise.resolve();
  assert.equal(updates[1].type, 'baseline');
  const value = updates[1].value;
  assert.equal(value.truncated, true);
  assert.equal(value.retainedFrom, 4);
  assert.equal(value.events.length, 2);
  assert.equal(value.activities.length, 2);
  assert.equal(value.revision, 5);
  let failures = 0;
  source.subscribe('root', (update) => {
    if (update.type !== 'baseline') {
      failures++;
      throw new Error('consumer failed');
    }
  });
  source.observe(fact({}, { sequence: 6 }));
  await Promise.resolve();
  source.observe(fact({}, { sequence: 7 }));
  await Promise.resolve();
  assert.equal(failures, 1, 'a broken subscriber does not disable its source or peers');
  assert.equal(source.query('root').revision, 7);
  source.close();
});

test('default Observer assembly consumes checkpoint metadata even if an optional observer fails', async () => {
  const settings = { model: 'fixture', contextBudget: 16000, maxOutputTokens: 1024, timeoutMs: 1000 };
  let observations = 0;
  const host = new ObserverConversations({ invoke: async (_request, purpose) => ({ id: 'feedback', model: 'fixture', content: JSON.stringify(purpose === 'selection' ? { historyIndexes: [] } : purpose === 'memory' ? { memories: [] } : { kind: 'answer', content: 'reply' }), finishReason: 'stop', usage: null }) }, [], {
    checkpointObservation: {
      observe() {
        observations++;
        throw new Error('optional observer failure');
      },
    },
  });
  const conversation = host.create();
  const environment = host.open(conversation.id);
  assert.equal((await environment.runtime.run({ messages: [{ role: 'user', content: 'hello' }] }, { settings })).content, 'reply');
  const [run] = environment.checkpointRuns.list(conversation.id);
  const snapshot = environment.checkpointObservation.query(run.rootContextId);
  assert.ok(snapshot.events.length > 3);
  assert.ok(snapshot.events.every((event) => !event.recovering));
  assert.ok(snapshot.activities.some((activity) => activity.contextId === run.rootContextId && activity.delivery === 'succeeded'));
  assert.equal(observations, 1);
  assert.ok(!JSON.stringify(snapshot).includes('"hello"'));
  assert.ok(!JSON.stringify(snapshot).includes('"reply"'));
  host.close();
});
