import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FactStore, identity, stableCodec, hash } from './fact-store.mjs';
import { FactCall } from './fact-call.mjs';

function fixture(t) {
  const store = new FactStore();
  t.after(() => store.close());
  return { store, root: new FactCall(store, identity('parent'), { query: 'fixed' }) };
}
const codecs = () => {
  const codec = stableCodec();
  return new Map([[codec.key, codec]]);
};
function complete(root, id, value = { text: 'one' }) {
  const child = root.createChild(id, { source: id });
  root.returned(child, value);
  root.receive(child, { text: value.text.toUpperCase() });
  root.reference(id, child);
  return child;
}
function counts(db) {
  return Object.fromEntries(['facts', 'events', 'heads', 'relations', 'refs'].map((table) => [table, db.prepare(`SELECT count(*) n FROM ${table}`).get().n]));
}

test('two saves fix original input/output/acceptance, publish only new facts, no child CP required', (t) => {
  const store = new FactStore();
  t.after(() => store.close());
  const input = { query: 'fixed' };
  const root = new FactCall(store, identity('parent'), input);
  input.query = 'changed';
  const raw = { text: 'one' };
  const child = complete(root, 'child-1', raw);
  raw.text = 'changed';
  assert.equal(root.stats.encodedFacts, 0, 'No persistence codecs before save');
  root.save('one', { step: 1 });
  assert.equal(store.readHead('child-1'), undefined, 'Parent can publish a child without its own CP');
  const first = new Map(root.encodings);
  const child2 = complete(root, 'child-2');
  const reads = root.stats.factReads;
  root.save('two', { step: 2 });
  assert.equal(root.stats.factReads, reads, 'No prior fact body reads for save');
  assert.equal(store.stats.oldBodyReads, 0);
  for (const [id, n] of first) assert.equal(root.encodings.get(id), n);
  assert.equal(root.encodings.size, 7);
  const restored = FactCall.reopen(store, 'parent');
  assert.deepEqual(restored.input, { query: 'fixed' });
  assert.deepEqual(restored.value(restored.relation(child).output), { text: 'one' });
  assert.deepEqual(restored.value(restored.relation(child).received), { text: 'ONE' });
  assert.equal(restored.relation(child2).phase, 'accepted');
  assert.equal(restored.allRelations().length, 2, 'Unreferenced relations are not dropped');
});

test('no-change save has no fact or metadata-event writes; author state/check still run', (t) => {
  const { store, root } = fixture(t);
  complete(root, 'one');
  root.save('one', null);
  const before = { ...store.stats };
  const reads = root.stats.factReads;
  root.save('two', { changed: true }, { check: (state) => assert.equal(state.changed, true) });
  assert.equal(store.stats.factsWritten, before.factsWritten);
  assert.equal(store.stats.metadataEvents, before.metadataEvents);
  assert.equal(root.stats.factReads, reads);
  assert.equal(root.stats.checks, 2);
  assert.equal(root.stats.stateEncodes, 2);
  assert.equal(store.stats.metadataReads - before.metadataReads, 2, 'Head + input metadata only');
});

test('author full check remains visible as history cost', (t) => {
  const { root } = fixture(t);
  for (let i = 0; i < 8; i++) {
    complete(root, `c${i}`);
    root.save('step', i, {
      check: (_state, facts) => {
        for (const r of facts.allRelations()) facts.value(r.received);
      },
    });
  }
  assert.equal(root.stats.authoredScans, 36);
});

test('waiting follows later successful child head, accepted does not follow it', (t) => {
  const { store, root } = fixture(t);
  const child = root.createChild('child', { text: 'input' });
  root.reference('active', child);
  root.save('waiting', null);
  const childCall = new FactCall(store, child, { text: 'input' });
  childCall.save('ready', { resume: 'without rerun' });
  childCall.finish({ text: 'later' });
  const resumed = FactCall.reopen(store, 'parent');
  assert.deepEqual(resumed.resolve(child), { mode: 'returned', value: { text: 'later' } });
  resumed.receive(child, { answer: 'accepted' });
  resumed.save('accepted', null);
  assert.equal(resumed.encodings.has('child:returned'), false, 'Existing durable delivery is linked');
  store.db.prepare('DELETE FROM heads WHERE owner=?').run('child');
  const again = FactCall.reopen(store, 'parent');
  assert.equal(again.resolve(child).mode, 'accepted', 'Saved delivery does not chase child head');
});

test('waiting with no first child checkpoint rejects instead of creating a new call', (t) => {
  const { store, root } = fixture(t);
  const child = root.createChild('no-first-save', null);
  root.save('waiting', null);
  assert.throws(() => FactCall.reopen(store, 'parent').resolve(child), /Missing checkpoint/);
  assert.equal(store.readHead(child.contextId), undefined);
});

test('configured model child without first save has no implicit finish; parent can still publish its returned value', (t) => {
  const { store, root } = fixture(t);
  const child = root.createChild('configured', null);
  const childCall = new FactCall(store, child, null);
  assert.throws(() => childCall.finish('result'), /No first checkpoint/);
  root.returned(child, 'result');
  root.receive(child, 'accepted');
  root.save('accepted', null);
  assert.equal(store.readHead('configured'), undefined);
  assert.equal(FactCall.reopen(store, 'parent').resolve(child).mode, 'accepted');
});

test('continuation state is decoded using the child head codec exactly once', (t) => {
  const { store, root } = fixture(t);
  const child = root.createChild('child', null);
  root.save('waiting', null);
  const childCall = new FactCall(store, child, null);
  childCall.save('ready', null);
  const head = store.readHead('child');
  store.commit({ identity: child, expected: head.revision, input: head.input, point: 'ready', state: '41', stateCodec: 'child-state@1', facts: [], events: [] });
  const available = codecs();
  let decoded = 0;
  available.set('child-state@1', {
    decode(body) {
      decoded++;
      return { count: Number(body) };
    },
  });
  const resumed = FactCall.reopen(store, 'parent', { codecs: available });
  assert.deepEqual(resumed.resolve(child), { mode: 'continuation', point: 'ready', state: { count: 41 } });
  assert.equal(decoded, 1);
});

test('active child exposes explicit continuation only; failed child cannot resume', (t) => {
  const { store, root } = fixture(t);
  const child = root.createChild('child', null);
  root.save('waiting', null);
  const childCall = new FactCall(store, child, null);
  childCall.save('ready', { count: 1 });
  assert.deepEqual(FactCall.reopen(store, 'parent').resolve(child), { mode: 'continuation', point: 'ready', state: { count: 1 } });
  childCall.fail();
  assert.throws(() => FactCall.reopen(store, 'parent').resolve(child), /Failed child/);
});

test('successful receiving preserves selected contract through restore', (t) => {
  const { store, root } = fixture(t);
  const child = root.createChild('child', null);
  root.returned(child, 'returned');
  root.beginReception(child, 'receive@1');
  root.save('receiving', null);
  const restored = FactCall.reopen(store, 'parent');
  assert.throws(() => restored.receive(child, 'bad', 'other@1'), /Reception contract changed/);
  restored.receive(child, 'accepted', 'receive@1');
  restored.save('accepted', null);
  assert.equal(FactCall.reopen(store, 'parent').relation(child).phase, 'accepted');
});

test('failed/handled preserves diagnostic and undefined value', (t) => {
  const { store, root } = fixture(t);
  const child = root.createChild('child', null);
  const error = { contextId: 'descendant', message: 'failed', progress: { phase: 'run' } };
  root.failed(child, error);
  error.message = 'changed';
  root.receive(child, undefined, 'recover@1');
  root.save('handled', null);
  const again = FactCall.reopen(store, 'parent');
  const relation = again.relation(child);
  assert.equal(relation.phase, 'handled');
  assert.equal(relation.result, 'failed');
  assert.equal(again.value(relation.output).message, 'failed');
  assert.equal(again.value(relation.output).contextId, 'descendant');
  assert.equal(again.value(relation.received), undefined);
  assert.throws(() => again.receive(child, 'overwrite', 'recover@1'), /Illegal relation/);
});

test('unprocessed failure cannot be saved as an active resumable head', (t) => {
  const { store, root } = fixture(t);
  root.save('first', null);
  const child = root.createChild('child', null);
  root.failed(child, { message: 'failed' });
  root.beginReception(child);
  const before = counts(store.db);
  assert.throws(() => root.save('receiving-failure', null), /Unprocessed failure/);
  assert.deepEqual(counts(store.db), before);
});

test('protected failures cannot enter receiving or handled', (t) => {
  const { root } = fixture(t);
  const child = root.createChild('child', null);
  root.failed(child, { code: 'protected' }, { receptionAllowed: false });
  assert.throws(() => root.receive(child, 'fallback'), /Protected failure/);
});

for (const cut of ['facts', 'events', 'before-head', 'head'])
  test(`transaction rollback at ${cut} leaves no partial facts/indices`, (t) => {
    const { store, root } = fixture(t);
    root.save('first', null);
    const before = counts(store.db);
    complete(root, 'child');
    assert.throws(
      () =>
        root.save('second', null, {
          fault: (at) => {
            if (at === cut) throw new Error('cut');
          },
        }),
      /cut/,
    );
    assert.deepEqual(counts(store.db), before);
    assert.throws(() => root.save('again', null), /uncertain/);
    assert.equal(FactCall.reopen(store, 'parent').allRelations().length, 0);
  });

test('commit success but receipt lost keeps durable success and blocks local mutation', (t) => {
  const { store, root } = fixture(t);
  root.save('first', null);
  assert.throws(
    () =>
      root.finish('done', {
        fault: (at) => {
          if (at === 'committed') throw new Error('lost');
        },
      }),
    /lost/,
  );
  assert.throws(() => root.fail(), /uncertain/);
  assert.equal(store.readHead('parent').status, 'succeeded');
  assert.throws(() => FactCall.reopen(store, 'parent').save('revive', null), /Terminal/);
});

for (const key of ['owner', 'revision', 'cursor', 'chain', 'headDigest'])
  test(`invalid ${key} receipt remains uncertain after real commit`, (t) => {
    const { store, root } = fixture(t);
    root.save('first', null);
    const commit = store.commit.bind(store);
    store.commit = (...args) => ({ ...commit(...args), [key]: 'wrong' });
    assert.throws(() => root.save('second', { changed: true }), /Invalid receipt/);
    assert.throws(() => root.save('third', null), /uncertain/);
    assert.equal(store.readHead('parent').revision, 2);
  });

test('revision conflict rolls back losing writer facts', (t) => {
  const { store, root } = fixture(t);
  root.save('first', null);
  const other = FactCall.reopen(store, 'parent');
  root.save('winner', null);
  const before = counts(store.db);
  complete(other, 'loser');
  assert.throws(() => other.save('loser', null), /Revision conflict/);
  assert.deepEqual(counts(store.db), before);
});

test('exact refs and child positions are enforced, all relationships retained', (t) => {
  const { store, root } = fixture(t);
  const child = complete(root, 'child');
  for (const wrong of [
    { ...child, order: 9 },
    { ...child, parentId: 'foreign' },
    { ...child, position: 'other' },
  ])
    assert.throws(() => root.reference('wrong', wrong), /Inaccurate/);
  const second = root.createChild('not-referenced', null);
  root.save('all', null);
  const restored = store.restore('parent', codecs());
  assert.equal(restored.relations.size, 2);
  assert.equal(restored.relations.get(second.contextId).phase, 'waiting');
});

test('first-publication codec failure leaves stable value and old head untouched', (t) => {
  const store = new FactStore();
  t.after(() => store.close());
  const base = stableCodec();
  let broken = false;
  const codec = {
    ...base,
    encode(value) {
      if (broken && value?.text === 'one') throw new Error('codec failed');
      return base.encode(value);
    },
  };
  const root = new FactCall(store, identity('parent'), null, { codec });
  root.save('first', null);
  const child = complete(root, 'child');
  const before = counts(store.db);
  broken = true;
  assert.throws(() => root.save('second', null), /codec failed/);
  assert.deepEqual(counts(store.db), before);
  assert.equal(root.value(root.relation(child).output).text, 'one');
  broken = false;
  root.save('second', null);
});

test('changing codec closure after publication does not rewrite fixed facts; new facts still use current codec', (t) => {
  const store = new FactStore();
  t.after(() => store.close());
  const base = stableCodec();
  let blockOld = false;
  const codec = {
    ...base,
    encode(value) {
      assert.ok(!blockOld || value?.text !== 'one', 'old body revisited');
      return base.encode(value);
    },
  };
  const root = new FactCall(store, identity('parent'), null, { codec });
  complete(root, 'child');
  root.save('first', null);
  blockOld = true;
  root.save('second', null);
  assert.equal(root.encodings.get('child:returned'), 1);
});

for (const corruption of ['missing-body', 'body', 'owner', 'codec', 'event-gap', 'event-body', 'head-chain', 'derived-index', 'derived-child-key', 'derived-order'])
  test(`cold restore rejects ${corruption}`, (t) => {
    const { store, root } = fixture(t);
    complete(root, 'child');
    root.save('one', null);
    if (corruption === 'missing-body') store.db.exec("DELETE FROM facts WHERE id='child:returned'");
    if (corruption === 'body') store.db.exec("UPDATE facts SET body='{}' WHERE id='child:returned'");
    if (corruption === 'owner') store.db.exec("UPDATE facts SET owner='wrong' WHERE id='child:returned'");
    if (corruption === 'codec') store.db.exec("UPDATE facts SET codec='wrong@1' WHERE id='child:returned'");
    if (corruption === 'event-gap') store.db.exec("DELETE FROM events WHERE owner='parent' AND seq=2");
    if (corruption === 'event-body') store.db.exec("UPDATE events SET body='{}' WHERE owner='parent' AND seq=2");
    if (corruption === 'head-chain') {
      const head = store.readHead('parent');
      const body = JSON.stringify({ ...head, chain: 'wrong' });
      store.db.prepare("UPDATE heads SET body=?,digest=? WHERE owner='parent'").run(body, hash(body));
    }
    if (corruption === 'derived-index') store.db.exec("DELETE FROM relations WHERE child='child'");
    if (corruption === 'derived-child-key') store.db.exec("UPDATE relations SET child='wrong' WHERE child='child'");
    if (corruption === 'derived-order') store.db.exec("UPDATE relations SET position=99 WHERE child='child'");
    assert.throws(() => store.restore('parent', codecs()));
  });

test('restored relation and reference contents cannot be mutated', (t) => {
  const { store, root } = fixture(t);
  const child = complete(root, 'child');
  root.save('one', null);
  const restored = FactCall.reopen(store, 'parent');
  assert.throws(() => {
    restored.relation(child).phase = 'waiting';
  }, TypeError);
  assert.throws(() => {
    restored.relation(child).identity.contextId = 'wrong';
  }, TypeError);
  assert.equal(restored.resolve(child).mode, 'accepted');
  restored.save('unchanged', null);
});

test('check has only reads; closure reentry and writes are rejected', (t) => {
  const { root } = fixture(t);
  root.save('one', null, {
    check: (_state, facts) => {
      assert.equal(facts.save, undefined);
      assert.equal(facts.createChild, undefined);
      assert.throws(() => root.save('reenter', null), /Reentrant/);
      assert.throws(() => root.createChild('reenter', null), /Reentrant/);
      assert.throws(() => root.finish('reenter'), /Reentrant/);
    },
  });
});

test('Store rejects reference to global fact not published in owner prefix', (t) => {
  const { store, root } = fixture(t);
  root.save('one', null);
  const child = identity('foreign', 'parent', 'child', 1);
  const childCall = new FactCall(store, child, null);
  childCall.save('child', null);
  const head = store.readHead('parent');
  const before = counts(store.db);
  const relation = { identity: child, input: 'foreign:input', phase: 'waiting', result: null, output: null, received: null, reception: null, allowed: false };
  assert.throws(() => store.commit({ identity: head.identity, expected: head.revision, input: head.input, state: head.state, stateCodec: head.stateCodec, point: 'bad', events: [{ type: 'relation', value: relation }], facts: [] }), /Missing fact/);
  assert.deepEqual(counts(store.db), before);
  assert.equal(FactCall.reopen(store, 'parent').allRelations().length, 0);
});

test('events after visible head cursor do not enter restored facts', (t) => {
  const { store, root } = fixture(t);
  root.save('first', null);
  const head = store.readHead('parent');
  store.db.prepare('INSERT INTO events VALUES (?,?,?,?,?)').run('parent', head.cursor + 1, head.chain, 'invalid-orphan', '{}');
  assert.equal(store.restore('parent', codecs()).values.size, 1);
});
