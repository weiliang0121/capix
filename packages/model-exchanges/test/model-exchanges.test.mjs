import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelExchanges, ModelExchangeResource, ModelExchangeViewSource, feedbackDigest, requireExchangeFeedbackReceipt, requireExchangeIntakeReceipt } from '@weiliang0121/capix-model-exchanges';
import { Resources, Resource } from '@weiliang0121/capix-resources';
import { PersistenceError } from '@weiliang0121/capix-diagnostics';

const basis = () => ({ request: { messages: [{ role: 'user', content: 'fixed prefix' }] }, catalog: { tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }], digest: 'catalog-v1', policyVersion: 'policy-v1' } });

const operation = (child, position = 'model-reply') => ({ parentContextId: 'loop', childContextId: child, position });
const result = (text = 'ok', status = 'ok') => ({ status, content: [{ kind: 'text', text }] });
const reply = (calls = ['a', 'b']) => ({ formatVersion: 1, id: 'reply', model: 'offline', output: calls.map((id) => ({ kind: 'tool-call', id, name: 'read', arguments: { encoding: 'json-text', text: '{"path":"a.md"}' } })), termination: { kind: 'completed', reason: 'tool_calls' }, usage: null, native: { format: 'chat-completions', version: 1 } });

test('model exchanges keep one frozen reply and exact feedback slots with fixed confirmation', () => {
  const entity = new ModelExchanges();
  const incoming = reply();
  const initial = entity.intake(entity.begin('scope', basis()), operation('model'), incoming);
  incoming.output[0].arguments.text = 'changed';
  assert.equal(entity.read(entity.begin('scope', basis()), initial).reply.output[0].arguments.text, '{"path":"a.md"}');
  const one = entity.complete(entity.begin('scope', basis()), initial, 'a', result('first'), operation('tool-a', 'tool-feedback'));
  assert.equal(entity.sequence, 3);
  assert.throws(() => entity.complete(entity.begin('scope', basis()), initial, 'b', result('stale')), /revision/);
  assert.deepEqual(entity.complete(entity.begin('scope', basis()), initial, 'a', result('first'), operation('tool-a', 'tool-feedback')), one);
  assert.throws(() => entity.complete(entity.begin('scope', basis()), initial, 'a', result('first')), /fixed slot/);
  assert.throws(() => entity.complete(entity.begin('scope', basis()), one, 'a', result('changed'), operation('tool-a', 'tool-feedback')), /fixed slot/);
  assert.throws(() => entity.complete(entity.begin('scope', basis()), one, 'unknown', result()), /Unknown/);
  assert.throws(() => entity.closed(entity.begin('scope', basis()), [one]), /missing/);
  const two = entity.complete(entity.begin('scope', basis()), one, 'b', result('precheck rejected', 'error'));
  const entry = entity.closed(entity.begin('scope', basis()), [two])[0];
  assert.equal(entry.receptions.length, 1, 'precheck feedback has no forged child operation');
  assert.deepEqual(
    entry.feedback.map((item) => item.status),
    ['ok', 'error'],
  );
  assert.ok(Object.isFrozen(entry.feedback[0].content[0]));
  assert.throws(() => entity.closed(entity.begin('scope', basis()), [two, two]), /Duplicate|prefix/);
  assert.equal(entity.sequence, 4, 'confirmations and refusals do not create changes');
});

test('operation keys and feedback digests ignore property construction order without losing origin or ownership', () => {
  const entity = new ModelExchanges();
  const original = operation('model');
  const ref = entity.intake(entity.begin('first', basis()), original, reply(['a']));
  const reordered = { position: original.position, childContextId: original.childContextId, parentContextId: original.parentContextId };
  assert.deepEqual(entity.intake(entity.begin('first', basis()), reordered, reply(['a'])), ref);
  assert.throws(() => entity.intake(entity.begin('other', basis()), original, reply(['a'])), /fixed operation/);
  assert.throws(() => entity.complete(entity.begin('first', basis()), ref, 'a', result(), original), /another effect/);
  const a = { toolCallId: 'a', status: 'ok', content: [{ kind: 'text', text: 'value' }] };
  const b = { content: [{ text: 'value', kind: 'text' }], status: 'ok', toolCallId: 'a' };
  assert.equal(feedbackDigest(a), feedbackDigest(b));
  assert.notEqual(feedbackDigest(a), feedbackDigest({ ...a, status: 'error' }));
});

test('two origins share one collection without confusing same tool IDs or exact source references', () => {
  const entity = new ModelExchanges();
  const first = entity.intake(entity.begin('alpha', basis()), operation('model-alpha'), reply(['shared-call']));
  const second = entity.intake(entity.begin('beta', basis()), operation('model-beta'), reply(['shared-call']));
  const secondDone = entity.complete(entity.begin('beta', basis()), second, 'shared-call', result('beta'));
  const firstDone = entity.complete(entity.begin('alpha', basis()), first, 'shared-call', result('alpha'));
  assert.equal(entity.read(entity.begin('alpha', basis()), firstDone).feedback[0].content[0].text, 'alpha');
  assert.equal(entity.read(entity.begin('beta', basis()), secondDone).feedback[0].content[0].text, 'beta');
  assert.throws(() => entity.read(entity.begin('alpha', basis()), secondDone), /origin|collection/);
  assert.throws(() => entity.read(entity.begin('alpha', basis()), { ...firstDone, collection: new ModelExchanges().id }), /origin|collection/);
  assert.deepEqual(
    entity.values().map((entry) => entry.origin),
    ['alpha', 'beta'],
  );
  const another = entity.intake(entity.begin('alpha', basis()), operation('new-model-alpha'), reply(['shared-call']));
  assert.notEqual(another.id, first.id, 'origin groups exchanges; it is not a one-call authorization lease');
});

test('snapshot restoration validates all data and retains exact operation confirmations', () => {
  const original = new ModelExchanges();
  const ref = original.intake(original.begin('scope', basis()), operation('model'), reply(['a']));
  const complete = original.complete(original.begin('scope', basis()), ref, 'a', result(), operation('tool', 'tool-feedback'));
  const raw = JSON.parse(JSON.stringify(original.snapshot()));
  const calls = [];
  const restored = ModelExchanges.restore(raw, {
    persistence: {
      commit: (change) => {
        calls.push(change);
      },
    },
  });
  raw.entries[0].reply.output[0].name = 'forged';
  assert.deepEqual(restored.snapshot(), original.snapshot());
  assert.ok(Object.isFrozen(restored.snapshot().entries[0].reply.output));
  assert.deepEqual(restored.intake(restored.begin('scope', basis()), operation('model'), reply(['a'])), complete);
  assert.deepEqual(restored.complete(restored.begin('scope', basis()), ref, 'a', result(), operation('tool', 'tool-feedback')), complete);
  assert.equal(calls.length, 0);
  for (const mutate of [
    (value) => {
      value.entries.push(value.entries[0]);
    },
    (value) => {
      value.sequence++;
    },
    (value) => {
      value.entries[0].sequence = 1;
    },
    (value) => {
      value.entries[0].revision = 9;
    },
    (value) => {
      value.entries[0].feedback[0].toolCallId = 'other';
    },
    (value) => {
      value.entries[0].receptions[0].operation = value.entries[0].operation;
    },
    (value) => {
      value.entries[0].extra = 'unsupported';
    },
  ]) {
    const value = structuredClone(original.snapshot());
    mutate(value);
    assert.throws(() => ModelExchanges.restore(value));
  }
  assert.equal(calls.length, 0, 'restoration never replays persistence or publication');
});

test('persistence runs before installation; an uncertain commit is protected and blocks later mutation', () => {
  let entity;
  let reject = false;
  let persisted;
  let attempts = 0;
  const events = [];
  const persistence = {
    commit(change) {
      attempts++;
      assert.equal(entity.sequence, change.expectedSequence);
      if (change.kind === 'exchange') assert.equal(entity.get(change.entry.id), change.previous ?? undefined);
      persisted = change;
      if (reject) throw new Error('store could have written before losing acknowledgement');
    },
  };
  entity = new ModelExchanges({ persistence, changes: { capture: (event) => events.push(event) } });
  const origin = entity.begin('scope', basis());
  const ref = entity.intake(origin, operation('model'), reply(['a']));
  assert.equal(events.length, 2);
  assert.equal(persisted.entry, entity.read(origin, ref));
  reject = true;
  let failure;
  assert.throws(
    () => entity.complete(origin, ref, 'a', result()),
    (error) => {
      failure = error;
      return error instanceof PersistenceError;
    },
  );
  assert.equal(entity.sequence, 2);
  assert.equal(entity.read(origin, ref).feedback.length, 0);
  assert.equal(events.length, 2);
  assert.throws(
    () => entity.complete(origin, ref, 'a', result()),
    (error) => error === failure,
  );
  assert.equal(attempts, 3, 'no implicit retry after an uncertain commit');
  const reloaded = ModelExchanges.restore({ ...entity.snapshot(), sequence: persisted.sequence, entries: [persisted.entry] });
  assert.equal(reloaded.sequence, 3, 'only authoritative host reload decides the persisted outcome');
});

test('invalid asynchronous persistence and mutation reentry never install partial state', () => {
  const asyncStore = new ModelExchanges({ persistence: { commit: async () => undefined } });
  assert.throws(() => asyncStore.intake(asyncStore.begin('scope', basis()), operation('model'), reply()), PersistenceError);
  assert.equal(asyncStore.sequence, 0);
  let entity;
  entity = new ModelExchanges({
    persistence: {
      commit() {
        entity.intake(entity.begin('scope', basis()), operation('nested'), reply());
      },
    },
  });
  assert.throws(() => entity.intake(entity.begin('scope', basis()), operation('model'), reply()), PersistenceError);
  assert.equal(entity.sequence, 0);
});

test('publication failure retains committed values and exact retry does not repeat persistence', () => {
  let writes = 0;
  const entity = new ModelExchanges({
    persistence: {
      commit() {
        writes++;
      },
    },
    changes: {
      capture() {
        throw new Error('consumer unavailable');
      },
    },
  });
  assert.throws(() => entity.begin('scope', basis()), /capture|consumer/i);
  assert.equal(entity.sequence, 1);
  assert.throws(() => entity.intake(entity.begin('scope', basis()), operation('model'), reply()), /capture|consumer/i);
  assert.equal(entity.sequence, 2);
  const ref = entity.intake(entity.begin('scope', basis()), operation('model'), reply());
  assert.equal(entity.read(entity.begin('scope', basis()), ref).reply.id, 'reply');
  assert.equal(writes, 2);
});

test('bounded pure-value validation and capacity checks happen before durable changes', () => {
  let writes = 0;
  const options = {
    persistence: {
      commit() {
        writes++;
      },
    },
    limits: { entries: 1 },
  };
  const entity = new ModelExchanges(options);
  entity.begin('scope', basis());
  const raw = reply();
  let invoked = false;
  Object.defineProperty(raw, 'id', {
    enumerable: true,
    get() {
      invoked = true;
      return 'reply';
    },
  });
  assert.throws(() => entity.intake(entity.begin('scope', basis()), operation('model'), raw), /accessor/);
  assert.equal(invoked, false);
  assert.equal(writes, 1);
  const ref = entity.intake(entity.begin('scope', basis()), operation('model'), reply());
  assert.throws(() => entity.intake(entity.begin('scope', basis()), operation('other'), reply()), /capacity/);
  assert.equal(writes, 2);
  assert.deepEqual(entity.intake(entity.begin('scope', basis()), operation('model'), reply()), ref, 'capacity refusal must not poison fixed confirmation');
  entity.complete(entity.begin('scope', basis()), ref, 'a', result(), operation('tool'));
  assert.equal(writes, 3, 'entry capacity still permits feedback on an existing exchange');
  assert.throws(() => ModelExchanges.restore(entity.snapshot(), { limits: { bytes: 1 } }), /limits/);
  const tiny = new ModelExchanges({ limits: { bytes: 1 } });
  assert.throws(() => tiny.intake(tiny.begin('scope', basis()), operation('model'), reply()), /capacity/);
  assert.equal(tiny.sequence, 0);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => requireExchangeIntakeReceipt(cyclic), /acyclic/);
});

test('resource ports bind reception provenance, origin and window without exposing a caller-supplied operation', () => {
  const entity = new ModelExchanges();
  const registry = new Resources().register(new Resource(entity), ModelExchangeResource);
  const binding = registry.bind({ exchanges: ModelExchangeResource.request() });
  const standalone = binding.open();
  const origin = standalone.endpoints.exchanges.begin('scope', basis());
  assert.throws(() => standalone.endpoints.exchanges.intake(origin, reply()), /reception/);
  standalone.close();
  const unrelatedActivity = binding.open({ contextId: 'loop', validate() {}, failures: { isProtected: (error) => error instanceof PersistenceError, isCancellation: () => false, describe: () => ({}) } });
  assert.throws(() => unrelatedActivity.endpoints.exchanges.intake(origin, reply()), /reception/);
  unrelatedActivity.close();
  let child = 'model';
  const access = binding.open({ contextId: 'loop', validate() {}, reception: () => ({ parentContextId: 'loop', childContextId: child }), failures: { isProtected: (error) => error instanceof PersistenceError, isCancellation: () => false, describe: () => ({}) } });
  const port = access.endpoints.exchanges;
  const accepted = requireExchangeIntakeReceipt(port.intake(origin, reply(['a'])));
  assert.deepEqual(accepted.operation, operation('model'));
  child = 'tool';
  const received = requireExchangeFeedbackReceipt(port.receive(origin, accepted.reference, 'a', result()));
  assert.deepEqual(received.operation, operation('tool', 'tool-feedback'));
  assert.equal(received.feedbackDigest, feedbackDigest(entity.read(entity.begin('scope', basis()), received.reference).feedback[0]));
  assert.equal(port.closed(origin, [received.reference]).length, 1);
  access.close();
  assert.throws(() => port.read(origin, received.reference), /closed/i);
});

test('view source versions include feedback changes; inspect and read access only selected exchanges', () => {
  const entity = new ModelExchanges();
  const first = entity.intake(entity.begin('alpha', basis()), operation('model-alpha'), reply(['a']));
  const second = entity.intake(entity.begin('beta', basis()), operation('model-beta'), reply(['a']));
  const source = new ModelExchangeViewSource(entity, entity.begin('alpha', basis()));
  const index = source.index();
  assert.deepEqual(
    index.entries.map((item) => item.key),
    [first.id],
  );
  const original = source.read([first.id], index.stamp);
  entity.values = () => assert.fail('local inspection must not enumerate the collection');
  assert.equal(source.inspect([first.id]).entries[0].summary.completed, 0);
  assert.throws(() => source.inspect([second.id]), /scope/);
  assert.throws(() => source.inspect([first.id, first.id]), /unique/);
  entity.complete(entity.begin('alpha', basis()), first, 'a', result());
  assert.equal(source.check(index.stamp), false);
  assert.throws(() => source.read([first.id], index.stamp), { code: 'VIEW_SOURCE_CONFLICT' });
  const current = source.inspect([first.id]);
  assert.equal(source.read([first.id], current.stamp).entries[0].value.feedback.length, 1);
  assert.equal(original.entries[0].value.feedback.length, 0, 'previous fixed values do not change');
});
