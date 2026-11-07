import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { ModelExchanges } from '@capix/model-exchanges';
import { requireModelRequest } from '@capix/model-provider';
import { ToolPrefixIndex } from './tool-prefix.mjs';

const scope = 'explicit-business-scope';
const operation = (id, parentContextId = 'same-parent') => ({ parentContextId, childContextId: id, position: 'model-reply' });
const result = (text = 'ok', status = 'ok') => ({ status, content: [{ kind: 'text', text }] });
const reply = (id, calls = []) => ({ formatVersion: 1, id, model: 'offline', output: calls.length ? calls.map((call) => ({ kind: 'tool-call', id: call, name: 'read', arguments: { encoding: 'json-text', text: '{}' } })) : [{ kind: 'text', text: id }], termination: { kind: 'completed', reason: calls.length ? 'tool_calls' : 'stop' }, usage: null, native: { format: 'chat-completions', version: 1 } });
const closed = (entity, id, selectedScope = scope) => entity.intake(selectedScope, operation(id), reply(id));

function fixture(t, entity = new ModelExchanges()) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-prefix-study-'));
  const path = join(directory, 'prefix.sqlite');
  const opened = [];
  const open = (owner = 'loop', selected = entity, selectedScope = scope) => {
    const index = new ToolPrefixIndex(path, { owner, scope: selectedScope, exchanges: selected, openExisting: opened.some((previous) => previous.owner === owner) });
    opened.push(index);
    return index;
  };
  t.after(() => {
    for (const index of opened) index.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { entity, directory, path, open, index: open() };
}

function damage(path, action) {
  const db = new DatabaseSync(path);
  try {
    action(db);
  } finally {
    db.close();
  }
}

function rewrite(path, id, change) {
  damage(path, (db) => {
    const row = db.prepare('SELECT body FROM tool_prefix_nodes WHERE id = ?').get(id);
    const body = JSON.parse(row.body);
    change(body);
    const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    db.prepare('UPDATE tool_prefix_nodes SET body = ?, digest = ? WHERE id = ?').run(JSON.stringify(body), digest, id);
  });
}

test('prefix uses real exact closed exchange revisions; completion does not create a predecessor', (t) => {
  const { entity, index } = fixture(t);
  const first = entity.intake(scope, operation('one'), reply('one', ['a', 'b']));
  assert.throws(() => index.append(null, first), /missing tool feedback/);
  const partial = entity.complete(scope, first, 'a', result());
  assert.equal(partial.id, first.id);
  assert.equal(partial.revision, first.revision + 1);
  assert.throws(() => index.append(null, partial), /missing tool feedback/);
  const complete = entity.complete(scope, partial, 'b', result('preflight rejection', 'error'));
  assert.throws(() => index.append(null, partial), /revision mismatch/);
  const token = index.append(null, complete);
  assert.equal(token.count, 1);
  assert.equal(index.inspect(token).exchange.id, first.id);
  assert.equal(index.materialize(token)[0].receptions.length, 0, 'No child relation is invented for preflight rejection');
  assert.equal(entity.values().length, 1, 'Three entity revisions still represent one exchange');
});

test('explicit independent owners choose different orders in one real collection and scope', (t) => {
  const { entity, index, open } = fixture(t);
  const a = closed(entity, 'created-first');
  const b = closed(entity, 'created-second');
  const firstOwner = index.append(index.append(null, b), a);
  const other = open('other-loop');
  const secondOwner = other.append(other.append(null, a), b);
  assert.deepEqual(
    index.materialize(firstOwner).map((entry) => entry.id),
    [b.id, a.id],
  );
  assert.deepEqual(
    other.materialize(secondOwner).map((entry) => entry.id),
    [a.id, b.id],
  );
  assert.equal(entity.read(scope, a).operation.parentContextId, entity.read(scope, b).operation.parentContextId);
  assert.throws(() => other.inspect(firstOwner), /owner mismatch/);
});

test('the selected loop policy is linear: stale append and duplicate exchange positions reject', (t) => {
  const { entity, index } = fixture(t);
  const a = closed(entity, 'a');
  const b = closed(entity, 'b');
  const c = closed(entity, 'c');
  const first = index.append(null, a);
  const second = index.append(first, b);
  assert.throws(() => index.append(first, c), /Stale prefix tip/);
  assert.throws(() => index.append(second, a), /another prefix position/);
  assert.deepEqual(index.tip(), second);
  assert.deepEqual(
    index.materialize(first).map((entry) => entry.id),
    [a.id],
    'Old prefix remains readable without becoming appendable',
  );
});

test('exact confirmation after later appends returns the original token without rewinding the tip', (t) => {
  const { entity, index } = fixture(t);
  const a = closed(entity, 'a');
  const b = closed(entity, 'b');
  const first = index.append(null, a);
  const second = index.append(first, b);
  assert.deepEqual(index.append(null, a), first);
  assert.deepEqual(index.tip(), second);
  assert.equal(index.metrics.writes, 2);
});

for (const point of ['row-inserted', 'tip-updated']) {
  test(`prefix interruption at ${point} rolls back metadata and tip together`, (t) => {
    const { entity, index, open } = fixture(t);
    const reference = closed(entity, 'a');
    assert.throws(
      () =>
        index.append(null, reference, {
          fault(at) {
            if (at === point) throw new Error('interruption');
          },
        }),
      /interruption/,
    );
    index.close();
    const restored = open();
    assert.equal(restored.tip(), null);
    const token = restored.append(null, reference);
    assert.equal(token.count, 1);
    assert.equal(restored.materialize(token).length, 1);
  });
}

test('committed append with lost acknowledgment is confirmed after reopen without duplicating the prefix', (t) => {
  const { entity, index, open } = fixture(t);
  const reference = closed(entity, 'a');
  assert.throws(
    () =>
      index.append(null, reference, {
        fault(at) {
          if (at === 'committed') throw new Error('acknowledgment lost');
        },
      }),
    /acknowledgment lost/,
  );
  const committed = index.tip();
  index.close();
  const restored = open();
  assert.deepEqual(restored.append(null, reference), committed);
  assert.equal(restored.metrics.writes, 0);
  assert.equal(restored.validate(committed).length, 1);
});

for (const point of ['row-inserted', 'tip-updated', 'committed']) {
  test(`hard process exit at ${point} preserves the metadata transaction and exact retry`, (t) => {
    const { entity, index, directory, path, open } = fixture(t);
    const reference = closed(entity, 'a');
    const entityPath = join(directory, 'entity.json');
    const referencePath = join(directory, 'reference.json');
    writeFileSync(entityPath, JSON.stringify(entity.snapshot()));
    writeFileSync(referencePath, JSON.stringify(reference));
    index.close();
    const moduleUrl = new URL('./tool-prefix.mjs', import.meta.url).href;
    const script = `
      import { readFileSync } from 'node:fs';
      import { ModelExchanges } from '@capix/model-exchanges';
      import { ToolPrefixIndex } from ${JSON.stringify(moduleUrl)};
      const [path, entityPath, referencePath, point] = process.argv.slice(1);
      const entity = ModelExchanges.restore(JSON.parse(readFileSync(entityPath, 'utf8')));
      const reference = JSON.parse(readFileSync(referencePath, 'utf8'));
      const index = new ToolPrefixIndex(path, {owner:'loop', scope:${JSON.stringify(scope)}, exchanges:entity});
      index.append(null, reference, { fault(at) { if(at === point) process.exit(73); } });
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, path, entityPath, referencePath, point], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.status, 73, child.stderr);
    const restored = open('loop', ModelExchanges.restore(JSON.parse(readFileSync(entityPath, 'utf8'))));
    const tipBeforeRetry = restored.tip();
    assert.equal(tipBeforeRetry === null, point !== 'committed');
    const confirmed = restored.append(null, reference);
    if (point === 'committed') assert.deepEqual(confirmed, tipBeforeRetry);
    assert.equal(restored.metrics.writes, point === 'committed' ? 0 : 1);
    assert.equal(restored.validate(confirmed).length, 1);
  });
}

test('prefix append surviving before the next CP can be confirmed from the old previous token', (t) => {
  const { entity, index, directory, open } = fixture(t);
  const a = closed(entity, 'a');
  const first = index.append(null, a);
  // The last durable CP only knew this previous token. The entity and prefix
  // commit next; no new CP is written before simulated restart.
  const cp = JSON.parse(JSON.stringify({ previous: first }));
  const b = closed(entity, 'b');
  const second = index.append(first, b);
  writeFileSync(join(directory, 'entity.json'), JSON.stringify(entity.snapshot()));
  index.close();
  const reloadedEntity = ModelExchanges.restore(JSON.parse(readFileSync(join(directory, 'entity.json'), 'utf8')));
  const restored = open('loop', reloadedEntity);
  assert.deepEqual(restored.append(cp.previous, b), second);
  assert.deepEqual(
    restored.validate(second).map((entry) => entry.id),
    [a.id, b.id],
  );
  assert.equal(restored.metrics.writes, 0);
});

test('compact model inputs reproduce the exact existing common ModelRequest when materialized', (t) => {
  const { entity, index } = fixture(t);
  const one = entity.intake(scope, operation('a'), reply('a', ['call-a']));
  const first = entity.complete(scope, one, 'call-a', result('tool output'));
  const two = entity.intake(scope, operation('b'), reply('b', ['call-b']));
  const second = entity.complete(scope, two, 'call-b', result('preflight denied', 'error'));
  const token = index.append(index.append(null, first), second);
  const messages = [{ role: 'user', content: 'fixed input' }];
  const project = (entries) => entries.map(({ reply, feedback }) => ({ reply, feedback }));
  const original = requireModelRequest({ messages, exchanges: project(entity.closed(scope, [first, second])) });
  const compact = requireModelRequest({ messages, exchanges: project(index.materialize(token)) });
  assert.deepEqual(compact, original);
});

test('scope, collection, owner, count, and token format are part of the exact prefix basis', (t) => {
  const { entity, index, open } = fixture(t);
  const reference = closed(entity, 'a');
  const token = index.append(null, reference);
  assert.throws(() => index.append(token, closed(entity, 'other', 'other-scope')), /scope or revision/);
  assert.throws(() => index.append(token, closed(new ModelExchanges(), 'other')), /scope or revision/);
  assert.throws(() => open('loop', entity, 'changed-scope'), /scope mismatch/);
  assert.throws(() => open('loop', new ModelExchanges()), /collection mismatch/);
  for (const changed of [{ owner: 'different' }, { collection: 'different' }, { scope: 'different' }, { count: 2 }, { formatVersion: 2 }, { digest: '0'.repeat(64) }]) {
    assert.throws(() => index.validate({ ...token, ...changed }));
  }
});

test('cold validation rejects missing exchange content rather than inferring it from prefix metadata', (t) => {
  const { entity, index, open } = fixture(t);
  const before = entity.snapshot();
  const token = index.append(null, closed(entity, 'late'));
  index.close();
  const missing = open('loop', ModelExchanges.restore(before));
  assert.throws(() => missing.validate(token), /scope or revision mismatch/);
});

test('cold validation rejects an incomplete or older exact exchange revision', (t) => {
  const { entity, index, open } = fixture(t);
  const reference = entity.intake(scope, operation('a'), reply('a', ['a']));
  const before = entity.snapshot();
  const complete = entity.complete(scope, reference, 'a', result());
  const token = index.append(null, complete);
  index.close();
  const older = open('loop', ModelExchanges.restore(before));
  assert.throws(() => older.validate(token), /scope or revision mismatch/);
});

test('cold validation detects a missing historical row even when the latest row remains valid', (t) => {
  const { entity, index, path, open } = fixture(t);
  const first = index.append(null, closed(entity, 'a'));
  const second = index.append(first, closed(entity, 'b'));
  index.close();
  damage(path, (db) => db.prepare('DELETE FROM tool_prefix_nodes WHERE id = ?').run(first.id));
  const restored = open();
  assert.equal(restored.inspect(second).token.count, 2, 'Hot point lookup makes no whole-chain claim');
  assert.throws(() => restored.validate(second), /stored rows|Missing prefix row/);
});

test('cold open requires the exact chain metadata and does not recreate a deleted owner', (t) => {
  const { entity, index, path, open } = fixture(t);
  index.append(null, closed(entity, 'a'));
  index.close();
  damage(path, (db) => db.exec('DELETE FROM tool_prefix_chains'));
  assert.throws(() => open(), /Missing prefix chain/);
  assert.throws(() => new ToolPrefixIndex(path, { owner: 'loop', scope, exchanges: entity }), /Missing prefix chain with existing nodes/);
  damage(path, (db) => assert.equal(db.prepare('SELECT count(*) count FROM tool_prefix_chains').get().count, 0));
});

for (const [name, update] of [
  ['missing tip', (db) => db.exec('UPDATE tool_prefix_chains SET tip = NULL')],
  ['unknown tip', (db) => db.exec("UPDATE tool_prefix_chains SET tip = 'missing'")],
  ['rewound tip', (db) => db.exec('UPDATE tool_prefix_chains SET tip = (SELECT id FROM tool_prefix_nodes WHERE ordinal = 1)')],
]) {
  test(`new append and chain audit reject ${name} without invalidating an existing prefix`, (t) => {
    const { entity, index, path, open } = fixture(t);
    const first = index.append(null, closed(entity, 'a'));
    const second = index.append(first, closed(entity, 'b'));
    index.close();
    damage(path, update);
    const restored = open();
    assert.equal(restored.validate(first).length, 1);
    assert.equal(restored.validate(second).length, 2);
    assert.throws(() => restored.tip());
    assert.throws(() => restored.auditChain());
    assert.throws(() => restored.append(second, closed(entity, 'c')));
  });
}

test('historical token validation confirms chain membership and returns only the selected prefix', (t) => {
  const { entity, index, open } = fixture(t);
  const a = closed(entity, 'a');
  const first = index.append(null, a);
  index.append(first, closed(entity, 'b'));
  index.close();
  const restored = open();
  assert.deepEqual(
    restored.validate(first).map((entry) => entry.id),
    [a.id],
  );
  assert.deepEqual(restored.validate(null), []);
  assert.equal(restored.tip().count, 2);
});

test('a missing later row cannot invalidate the selected immutable earlier prefix', (t) => {
  const { entity, index, path, open } = fixture(t);
  const a = closed(entity, 'a');
  const first = index.append(null, a);
  const second = index.append(first, closed(entity, 'b'));
  index.close();
  damage(path, (db) => db.prepare('DELETE FROM tool_prefix_nodes WHERE id = ?').run(second.id));
  const restored = open();
  assert.deepEqual(
    restored.validate(first).map((entry) => entry.id),
    [a.id],
  );
  assert.throws(() => restored.validate(second), /Missing prefix row/);
  assert.throws(() => restored.tip(), /Missing prefix row/);
  assert.throws(() => restored.append(first, closed(entity, 'c')), /Missing prefix row/);
});

test('cold validation detects damaged body and does not treat a previously issued token as proof', (t) => {
  const { entity, index, path, open } = fixture(t);
  const token = index.append(null, closed(entity, 'a'));
  index.close();
  damage(path, (db) => db.prepare('UPDATE tool_prefix_nodes SET body = replace(body, ?, ?) WHERE id = ?').run('"count":1', '"count":2', token.id));
  assert.throws(() => open().validate(token), /Damaged prefix body/);
});

for (const [name, change] of [
  [
    'scope',
    (body) => {
      body.scope = 'foreign';
    },
  ],
  [
    'format',
    (body) => {
      body.formatVersion = 2;
    },
  ],
  [
    'exchange revision',
    (body) => {
      body.exchange.revision += 1;
    },
  ],
  [
    'predecessor count',
    (body) => {
      body.count = 2;
    },
  ],
]) {
  test(`rewritten metadata with a recomputed digest still rejects wrong ${name}`, (t) => {
    const { entity, index, path, open } = fixture(t);
    const token = index.append(null, closed(entity, 'a'));
    index.close();
    rewrite(path, token.id, change);
    assert.throws(() => open().validate(token));
  });
}

test('a newly read stored token with recomputed digest still needs real exact exchange validation', (t) => {
  const { entity, index, path, open } = fixture(t);
  const token = index.append(null, closed(entity, 'a'));
  index.close();
  rewrite(path, token.id, (body) => {
    body.exchange.revision += 1;
  });
  const restored = open();
  const changedToken = restored.tip();
  assert.notEqual(changedToken.digest, token.digest);
  assert.throws(() => restored.validate(changedToken), /scope or revision mismatch/);
});

test('linear append touches bounded metadata while full request reconstruction explicitly visits the prefix', (t) => {
  const { entity, index } = fixture(t);
  let token = null;
  let firstBytes;
  for (let indexNumber = 0; indexNumber < 128; indexNumber += 1) {
    const before = { ...index.metrics };
    token = index.append(token, closed(entity, `model-${indexNumber}`));
    assert.equal(index.metrics.nodeReads - before.nodeReads, indexNumber === 0 ? 0 : 1);
    assert.equal(index.metrics.chainReads - before.chainReads, 1);
    assert.equal(index.metrics.duplicateReads - before.duplicateReads, 1);
    assert.equal(index.metrics.exactExchangeReads - before.exactExchangeReads, 1);
    assert.equal(index.metrics.materializeVisits - before.materializeVisits, 0);
    const bytes = Buffer.byteLength(JSON.stringify({ previous: token }));
    firstBytes ??= bytes;
    assert.ok(bytes <= firstBytes + 2, 'Only count digits grow; no prefix array is embedded');
  }
  assert.equal(index.metrics.writes, 128);
  assert.equal(index.validate(token).length, 128);
  assert.equal(index.metrics.materializeVisits, 128);
  assert.equal(index.metrics.exactExchangeReads, 256);
});

test('prefix append fault hooks cannot reenter or close the index during a transaction', (t) => {
  const { entity, index } = fixture(t);
  const reference = closed(entity, 'a');
  assert.throws(
    () =>
      index.append(null, reference, {
        fault(at) {
          if (at === 'row-inserted') index.append(null, reference);
        },
      }),
    /cannot reenter/,
  );
  assert.equal(index.tip(), null);
  assert.throws(
    () =>
      index.append(null, reference, {
        fault(at) {
          if (at === 'row-inserted') index.close();
        },
      }),
    /Cannot close/,
  );
  assert.equal(index.tip(), null);
  index.close();
  assert.throws(() => index.materialize(null), /closed/);
});
