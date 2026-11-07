import assert from 'node:assert/strict';
import { writeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ModelExchanges } from '@capix/model-exchanges';
import { FactStore, identity, stableCodec } from './fact-store.mjs';
import { FactCall } from './fact-call.mjs';
import { ToolPrefixIndex } from './tool-prefix.mjs';

// Three independent durable stores. Every cut bypasses finally. This proves a
// compact token in the experimental head, not a production Invocation migration
// or a transaction spanning exchanges, prefix metadata, and checkpoint facts.
const [mode, path, cut = 'none'] = process.argv.slice(2);
const scope = 'prefix-head-study';
const owner = 'loop';
const feedback = { status: 'ok', content: [{ kind: 'text', text: 'fixed tool result' }] };
const feedbackOperation = { parentContextId: owner, childContextId: 'tool', position: 'feedback' };
const reply = { formatVersion: 1, id: 'fixed-reply', model: 'offline', output: [{ kind: 'tool-call', id: 'call', name: 'read', arguments: { encoding: 'json-text', text: '{}' } }], termination: { kind: 'completed', reason: 'tool_calls' }, usage: null, native: { format: 'chat-completions', version: 1 } };
const store = new FactStore(path);
const entityDb = new DatabaseSync(`${path}.entity`);
entityDb.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS entity(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL) STRICT');
let entity;
let prefixes;
let entityWrites = 0;
const persistence = {
  commit(change) {
    const previous = entity.snapshot();
    assert.equal(previous.sequence, change.expectedSequence);
    const entries = previous.entries.filter((entry) => entry.id !== change.entry.id);
    entries.push(change.entry);
    entries.sort((left, right) => left.sequence - right.sequence);
    const next = { ...previous, sequence: change.sequence, entries };
    entityDb.prepare('UPDATE entity SET body = ? WHERE id = 1').run(JSON.stringify(next));
    entityWrites += 1;
  },
};
function stop(at) {
  if (cut === at) process.exit(73);
}
function emit(status, extras = {}) {
  const head = store.readHead(owner);
  writeSync(1, JSON.stringify({ status, ...extras, headStatus: head?.status, headRevision: head?.revision, entityWrites, entitySequence: entity?.sequence, exchangeIds: entity?.values().map((entry) => entry.id), prefix: prefixes?.tip(), prefixWrites: prefixes?.metrics.writes }) + '\n');
}
function checkState(state) {
  assert.ok(state && typeof state === 'object');
  assert.deepEqual(state.feedbackOperation, feedbackOperation);
  if (state.prefix !== null) {
    const entries = prefixes.validate(state.prefix);
    assert.equal(entries.length, 1);
    assert.deepEqual(entity.reference(entries[0]), state.exchange);
  }
}
function link(root, state) {
  // Existing complete() confirms the original fixed feedback. It does not
  // resend a model request, execute a tool, or invent a new operation identity.
  const complete = entity.complete(scope, state.exchange, 'call', feedback, state.feedbackOperation);
  stop('entity-closed');
  const token = prefixes.append(state.prefix, complete, {
    fault(at) {
      if (at === 'committed') stop('prefix-committed');
    },
  });
  const next = { prefix: token, exchange: complete, feedbackOperation };
  root.save('prefix-linked', next, {
    check: checkState,
    fault(at) {
      if (at === 'head') stop('cp-uncommitted');
      if (at === 'committed') stop('cp-committed');
    },
  });
  return token;
}
try {
  if (mode === 'run') {
    assert.equal(entityDb.prepare('SELECT count(*) count FROM entity').get().count, 0, 'Run requires an empty entity store');
    entity = new ModelExchanges({ persistence });
    entityDb.prepare('INSERT INTO entity VALUES (1, ?)').run(JSON.stringify(entity.snapshot()));
    prefixes = new ToolPrefixIndex(`${path}.prefix`, { owner, scope, exchanges: entity });
    const initial = entity.intake(scope, { parentContextId: owner, childContextId: 'model', position: 'model' }, reply);
    const root = new FactCall(store, identity(owner), { collection: entity.id, scope });
    const state = { prefix: null, exchange: initial, feedbackOperation };
    root.save('awaiting-feedback', state);
    const token = link(root, state);
    root.finish(
      { prefix: token },
      {
        fault(at) {
          if (at === 'committed') stop('terminal-committed');
        },
      },
    );
    emit('completed');
  } else if (mode === 'resume') {
    const saved = entityDb.prepare('SELECT body FROM entity WHERE id = 1').get();
    assert.ok(saved, 'Missing actual exchange entity');
    entity = ModelExchanges.restore(JSON.parse(saved.body), { persistence });
    prefixes = new ToolPrefixIndex(`${path}.prefix`, { owner, scope, exchanges: entity, openExisting: true });
    const codec = stableCodec();
    const restored = store.restore(owner, new Map([[codec.key, codec]]));
    const root = FactCall.reopen(store, owner);
    assert.deepEqual(root.input, { collection: entity.id, scope });
    if (restored.head.status !== 'active') {
      const output = restored.values.get(restored.head.delivery);
      prefixes.validate(output.prefix);
      assert.throws(() => root.save('resurrect', null), /Terminal call cannot resume/);
      emit('terminal');
    } else {
      assert.ok(['awaiting-feedback', 'prefix-linked'].includes(restored.head.point), 'Unknown prefix/head point');
      checkState(restored.state);
      const token = restored.head.point === 'awaiting-feedback' ? link(root, restored.state) : restored.state.prefix;
      assert.ok(token, 'Missing linked prefix');
      prefixes.validate(token);
      root.finish({ prefix: token });
      emit('completed');
    }
  } else throw new Error('Unknown prefix/head fixture mode');
} catch (error) {
  // Damaged prefix rows may also prevent normal diagnostic tip lookup.
  writeSync(1, JSON.stringify({ status: 'rejected', error: error.message, entityWrites, prefixWrites: prefixes?.metrics.writes }) + '\n');
} finally {
  prefixes?.close();
  entityDb.close();
  store.close();
}
