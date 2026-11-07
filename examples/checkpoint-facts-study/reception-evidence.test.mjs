import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FactStore, identity } from './fact-store.mjs';
import { StableValues } from './stable.mjs';
import { ReceptionEvidenceCall } from './reception-evidence.mjs';

function contract(options = {}) {
  return {
    key: 'text',
    version: 1,
    childPosition: 'child',
    check(value) {
      assert.equal(typeof value?.text, 'string');
    },
    codec: { encode: (value) => value, decode: (value) => value },
    ...options,
  };
}

function fixture(t, registered = contract()) {
  const store = new FactStore();
  t.after(() => store.close());
  const owner = identity('parent');
  const values = new StableValues();
  const call = new ReceptionEvidenceCall(store, owner, { query: 'fixed' }, { contracts: [registered], values });
  return { store, owner, values, call, registered };
}

function child(call, id = 'child', failed = false) {
  const result = call.createChild(id, { input: 'fixed' });
  if (failed) call.failed(result, { message: 'business failure' });
  else call.returned(result, { text: 'returned' });
  return result;
}

test('stable then check then install isolates original drafts without a CP save', (t) => {
  let checked;
  const registered = contract({
    check(value) {
      checked = value;
      assert.ok(Object.isFrozen(value));
      assert.ok(Object.isFrozen(value.nested));
    },
  });
  const { call } = fixture(t, registered);
  const target = child(call);
  const draft = { text: 'accepted', nested: { count: 1 } };
  const result = call.establish(target, 'accepted', draft, registered);
  draft.text = 'changed';
  draft.nested.count = 99;
  assert.equal(checked, result);
  assert.deepEqual(call.value(target), { text: 'accepted', nested: { count: 1 } });
  assert.equal(call.relation(target).phase, 'accepted');
  assert.equal(call.stats.establishmentCheck, 1);
  assert.equal(call.stats.receptionEncode, 0);
  assert.equal(call.stats.published, 0);
});

test('handled uses the same fixed contract without changing child failure', (t) => {
  const { call, registered, store, owner } = fixture(t);
  const target = child(call, 'failed-child', true);
  call.establish(target, 'handled', { text: 'fallback' }, registered);
  assert.equal(call.relation(target).result, 'failed');
  call.save('handled', null);
  const restored = ReceptionEvidenceCall.reopen(store, owner, { contracts: [contract()] });
  assert.equal(restored.relation(target).phase, 'handled');
  assert.equal(restored.relation(target).result, 'failed');
  assert.equal(restored.value(target).text, 'fallback');
  assert.equal(restored.stats.restoredCheck, 1);
});

for (const cause of [undefined, new Error('invalid')]) {
  test(`check rejection ${String(cause)} never installs a reception`, (t) => {
    const registered = contract({
      check() {
        throw cause;
      },
    });
    const { call } = fixture(t, registered);
    const target = child(call);
    assert.throws(
      () => call.establish(target, 'accepted', { text: 'invalid' }, registered),
      (error) => error.message.includes('fixed contract') && Object.hasOwn(error, 'cause') && error.cause === cause,
    );
    assert.equal(call.relation(target).phase, 'receiving');
    assert.equal(call.relation(target).received, null);
    assert.equal(call.stats.installed, 0);
    assert.throws(() => call.save('invalid', null), /establishment failed/);
  });
}

test('unsupported candidate fails fixing before checking', (t) => {
  const { call, registered } = fixture(t);
  const target = child(call);
  assert.throws(() => call.establish(target, 'accepted', { text: 'a', fn() {} }, registered), /could not be fixed/);
  assert.equal(call.stats.establishmentCheck, 0);
  assert.equal(call.stats.installed, 0);
});

test('throw undefined during fixing remains an explicit failure', (t) => {
  const { call, registered } = fixture(t);
  const target = child(call);
  const candidate = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw undefined;
      },
    },
  );
  assert.throws(
    () => call.establish(target, 'accepted', candidate, registered),
    (error) => error.message.includes('could not be fixed') && Object.hasOwn(error, 'cause') && error.cause === undefined,
  );
  assert.equal(call.stats.installed, 0);
  assert.equal(call.stats.establishmentCheck, 0);
});

test('check cannot mutate its stable input or publish reentrant facts', (t) => {
  let call;
  const registered = contract({
    check(value) {
      assert.throws(() => {
        value.text = 'changed';
      }, TypeError);
      call.createChild('reentrant', null);
    },
  });
  call = fixture(t, registered).call;
  const target = child(call);
  assert.throws(() => call.establish(target, 'accepted', { text: 'a' }, registered), /fixed contract/);
  assert.equal(call.stats.installed, 0);
});

test('thenable checks are rejected rather than treated as synchronous proof', (t) => {
  const registered = contract({ check: async () => {} });
  const { call } = fixture(t, registered);
  const target = child(call);
  assert.throws(() => call.establish(target, 'accepted', { text: 'a' }, registered), /fixed contract/);
  assert.equal(call.stats.installed, 0);
});

test('the first persistent representation is checked; no-change saves touch no old fact body', (t) => {
  const { call, registered, store, values } = fixture(t);
  const target = child(call);
  call.establish(target, 'accepted', { text: 'a' }, registered);
  call.save('one', null);
  const checks = { ...call.stats };
  const encodings = call.encodings;
  const reads = call.factStats.factReads;
  const storeReads = store.stats.oldBodyReads;
  const visits = values.visits;
  call.save('two', null);
  assert.deepEqual(call.stats, checks);
  assert.deepEqual(call.encodings, encodings);
  assert.equal(call.factStats.factReads, reads);
  assert.equal(store.stats.oldBodyReads, storeReads);
  assert.ok(values.visits > visits, 'Current state/wire work still occurs; not a whole-save O(1) claim');
  assert.equal(call.stats.establishmentCheck, 1);
  assert.equal(call.stats.persistenceCheck, 1);
  assert.equal(call.stats.published, 1);
});

test('incremental pending facts do not recheck a prior reception', (t) => {
  const checked = [];
  const registered = contract({
    check(value) {
      checked.push(value.text);
    },
  });
  const { call, store } = fixture(t, registered);
  const first = child(call, 'first');
  call.establish(first, 'accepted', { text: 'first' }, registered);
  call.save('one', null);
  checked.length = 0;
  const second = child(call, 'second');
  call.establish(second, 'accepted', { text: 'second' }, registered);
  call.save('two', null);
  assert.deepEqual(checked, ['second', 'second']);
  assert.equal(store.stats.oldBodyReads, 0);
  assert.equal(call.stats.published, 2);
});

test('changed point and state still run author checks without rechecking old reception', (t) => {
  const { call, registered, store } = fixture(t);
  const target = child(call);
  call.establish(target, 'accepted', { text: 'a' }, registered);
  call.save('ready', { cursor: 0 });
  const before = { ...call.stats };
  let checks = 0;
  assert.throws(() =>
    call.save(
      'finished',
      { cursor: 99 },
      {
        check(state) {
          checks++;
          assert.equal(state.cursor, 0);
        },
      },
    ),
  );
  assert.equal(checks, 1);
  assert.deepEqual(call.stats, before);
  assert.equal(store.readHead('parent').point, 'ready');
});

for (const [label, codec, match] of [
  [
    'encode throws',
    {
      encode() {
        throw new Error('encode failed');
      },
      decode: (value) => value,
    },
    /encode failed/,
  ],
  [
    'decode throws',
    {
      encode: (value) => value,
      decode() {
        throw new Error('decode failed');
      },
    },
    /decode failed/,
  ],
  ['decode invalid', { encode: (value) => value, decode: () => ({ text: 3 }) }, /fixed contract/],
  ['decode valid but lossy', { encode: (value) => value, decode: () => ({ text: 'silently changed' }) }, /Codec changed fact semantics/],
]) {
  test(`${label}: failed persistence does not undo accepted or certify its wire value`, (t) => {
    const registered = contract({ codec });
    const { call, store } = fixture(t, registered);
    const target = child(call);
    call.establish(target, 'accepted', { text: 'original' }, registered);
    assert.throws(() => call.save('one', null), match);
    assert.equal(call.relation(target).phase, 'accepted');
    assert.deepEqual(call.value(target), { text: 'original' });
    assert.equal(call.stats.published, 0);
    assert.equal(store.readHead('parent'), undefined);
  });
}

test('failed first encoding is attempted again; it does not install a cache entry', (t) => {
  let failing = true;
  const registered = contract({
    codec: {
      encode(value) {
        if (failing) throw new Error('temporary');
        return value;
      },
      decode: (value) => value,
    },
  });
  const { call } = fixture(t, registered);
  const target = child(call);
  call.establish(target, 'accepted', { text: 'a' }, registered);
  assert.throws(() => call.save('one', null), /temporary/);
  failing = false; // Fault injection only, not a recommended effectful codec.
  call.save('two', null);
  assert.equal(call.stats.receptionEncode, 2);
  assert.equal(call.stats.persistenceCheck, 1);
  assert.equal(call.stats.published, 1);
});

test('commit uncertainty retains acceptance but cannot manufacture publication proof', (t) => {
  const { call, registered, store, owner } = fixture(t);
  const target = child(call);
  call.establish(target, 'accepted', { text: 'a' }, registered);
  assert.throws(
    () =>
      call.save('one', null, {
        fault(stage) {
          if (stage === 'committed') throw new Error('lost receipt');
        },
      }),
    /lost receipt/,
  );
  assert.equal(call.relation(target).phase, 'accepted');
  assert.equal(call.stats.published, 0);
  assert.throws(() => call.save('two', null), /uncertain/);
  const restored = ReceptionEvidenceCall.reopen(store, owner, { contracts: [contract()] });
  assert.equal(restored.stats.restoredCheck, 1);
  assert.equal(restored.value(target).text, 'a');
});

test('same content in different child relations establishes and persists two facts', (t) => {
  const { call, registered } = fixture(t);
  const raw = { text: 'same' };
  const first = child(call, 'first');
  const second = child(call, 'second');
  const one = call.establish(first, 'accepted', raw, registered);
  call.establish(second, 'accepted', one, registered);
  call.save('two', null);
  assert.equal(call.stats.establishmentCheck, 2);
  assert.equal(call.stats.persistenceCheck, 2);
  assert.notEqual(call.relation(first).received, call.relation(second).received);
});

test('same-shaped replacement registration is not the exact live contract', (t) => {
  const { call, registered } = fixture(t);
  const target = child(call);
  assert.throws(() => call.establish(target, 'accepted', { text: 'a' }, { ...registered }), /exact registration/);
  assert.equal(call.relation(target).phase, 'returned');
});

test('one stable value under two registered contracts still needs two independent checks', (t) => {
  const ordinary = contract();
  const strict = contract({
    key: 'strict',
    check(value) {
      assert.ok(value.text.length > 10);
    },
  });
  const store = new FactStore();
  t.after(() => store.close());
  const call = new ReceptionEvidenceCall(store, identity('parent'), null, { contracts: [ordinary, strict] });
  const first = child(call, 'first');
  const second = child(call, 'second');
  const stable = call.establish(first, 'accepted', { text: 'short' }, ordinary);
  assert.throws(() => call.establish(second, 'accepted', stable, strict), /fixed contract/);
  assert.equal(call.stats.establishmentCheck, 2);
  assert.equal(call.relation(first).phase, 'accepted');
  assert.equal(call.relation(second).phase, 'receiving');
  assert.equal(call.stats.installed, 1);
});

test('a different contract cannot replace the already entered receiving contract', (t) => {
  const one = contract();
  const two = contract({ key: 'other' });
  const store = new FactStore();
  t.after(() => store.close());
  const call = new ReceptionEvidenceCall(store, identity('parent'), null, { contracts: [one, two] });
  const target = child(call);
  call.beginReception(target, one);
  assert.throws(() => call.establish(target, 'accepted', { text: 'a' }, two), /Reception contract changed/);
  assert.equal(call.stats.establishmentCheck, 0);
});

test('wrong child position, duplicate acceptance and outcome mismatch reject', (t) => {
  const { call, registered } = fixture(t);
  const other = call.createChild('other', null, { position: 'elsewhere' });
  call.returned(other, null);
  assert.throws(() => call.establish(other, 'accepted', { text: 'a' }, registered), /another child position/);
  const target = child(call);
  assert.throws(() => call.establish(target, 'handled', { text: 'a' }, registered), /outcome/);
  call.establish(target, 'accepted', { text: 'a' }, registered);
  assert.throws(() => call.establish(target, 'accepted', { text: 'a' }, registered), /Illegal relation/);
  assert.equal(call.stats.installed, 1);
});

test('cold restoration checks fresh decoded values and refuses changed bound version or owner', (t) => {
  const { call, registered, store, owner } = fixture(t);
  const target = child(call);
  call.establish(target, 'accepted', { text: 'a' }, registered);
  call.save('saved', null);
  const restored = ReceptionEvidenceCall.reopen(store, owner, { contracts: [contract()] });
  assert.equal(restored.stats.establishmentCheck, 0);
  assert.equal(restored.stats.persistenceCheck, 0);
  assert.equal(restored.stats.restoredCheck, 1);
  assert.equal(restored.stats.restoredBodyReads, 1);
  assert.throws(() => ReceptionEvidenceCall.reopen(store, owner, { contracts: [contract({ version: 2 })] }), /Incompatible reception contract/);
  assert.throws(() => ReceptionEvidenceCall.reopen(store, { ...owner, contract: 'different@2' }, { contracts: [contract()] }), /owner\/contract changed/);
  const before = { ...restored.stats };
  restored.save('continued', { cursor: 1 });
  assert.deepEqual(restored.stats, before, 'Authenticated restored facts can be linked without body rechecks');
});

test('an arbitrary lookalike input cannot claim reception authentication', (t) => {
  let checks = 0;
  const registered = contract({
    check() {
      checks++;
    },
  });
  const store = new FactStore();
  t.after(() => store.close());
  const raw = { owner: 'parent', child: identity('child', 'parent', 'child', 1), kind: 'accepted', contract: { key: 'text', version: 1, childPosition: 'child' }, value: { text: 'looks legitimate' } };
  const call = new ReceptionEvidenceCall(store, identity('parent'), raw, { contracts: [registered] });
  call.save('one', raw);
  ReceptionEvidenceCall.reopen(store, identity('parent'), { contracts: [registered] });
  assert.equal(checks, 0);
  assert.equal(call.stats.installed, 0);
});

test('a changed mutable policy is a contract violation: hot skipping does not promise safe cold recovery', (t) => {
  let minimum = 1;
  const registered = contract({
    check(value) {
      assert.ok(value.score >= minimum);
    },
  });
  const { call, store, owner } = fixture(t, registered);
  const target = child(call);
  call.establish(target, 'accepted', { score: 2 }, registered);
  call.save('one', null);
  minimum = 3;
  call.save('two', null);
  assert.throws(() => ReceptionEvidenceCall.reopen(store, owner, { contracts: [registered] }), /fixed contract/);
  assert.equal(call.value(target).score, 2);
});

test('unversioned decoder drift to another valid value is not automatically detectable during cold restore', (t) => {
  const { call, registered, store, owner } = fixture(t);
  const target = child(call);
  call.establish(target, 'accepted', { text: 'original' }, registered);
  call.save('one', null);
  const changed = contract({ codec: { encode: (value) => value, decode: () => ({ text: 'drifted' }) } });
  const restored = ReceptionEvidenceCall.reopen(store, owner, { contracts: [changed] });
  assert.equal(restored.value(target).text, 'drifted');
  assert.equal(restored.stats.restoredCheck, 1);
  // Deliberate negative control. The protocol stores one encoded representation,
  // not a second raw truth. Changing its meaning requires a contract version;
  // purity and matching function names cannot establish implementation identity.
});

test('a validator return value is not a transformation of the installed value', (t) => {
  const registered = contract({ check: () => ({ text: 'replacement' }) });
  const { call } = fixture(t, registered);
  const target = child(call);
  call.establish(target, 'accepted', { text: 'original' }, registered);
  assert.equal(call.value(target).text, 'original');
  call.save('one', null);
  assert.equal(call.value(target).text, 'original');
});
