import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transcript } from '@weiliang0121/capix-transcript';
import { Memories } from '@weiliang0121/capix-memory';
import { characterizeCurrent } from './current.mjs';
import { Facts, FixedData, StudyJournal, digest, restoreBundle } from './model.mjs';

test('current production: CP on/off both retain mutable aliases; child finish need not create a head', async () => {
  await characterizeCurrent();
});

test('B: encoding once leaves live facts changed before detection; zero codec calls still scans old content', () => {
  const raw = { nested: { text: 'returned' } };
  const live = Object.freeze({ output: raw });
  let codecCalls = 0;
  let scannedBytes = 0;
  const encode = (value) => {
    codecCalls++;
    return JSON.stringify(value);
  };
  const original = encode(raw);
  const originalDigest = digest(original);
  const verify = () => {
    // This is NOT the codec. Its work must nevertheless be counted.
    const current = JSON.stringify(live.output);
    scannedBytes += Buffer.byteLength(current);
    assert.equal(digest(current), originalDigest, 'Mutation detected late');
  };
  verify();
  raw.nested.text = 'changed';
  assert.equal(live.output.nested.text, 'changed');
  assert.equal(JSON.parse(original).nested.text, 'returned');
  assert.throws(verify, /Mutation detected late/);
  assert.equal(codecCalls, 1);
  assert.ok(scannedBytes > Buffer.byteLength(original));
});

test('B: a lossy codec digest cannot certify the whole original value; proxy does not own old aliases', () => {
  const raw = { text: 'before', local: { note: 'first' } };
  const projection = (value) => JSON.stringify({ text: value.text });
  const before = digest(projection(raw));
  const proxy = new Proxy(raw, { set: () => assert.fail('proxy write') });
  raw.local.note = 'changed outside proxy';
  assert.equal(proxy.local.note, 'changed outside proxy');
  assert.equal(digest(projection(raw)), before);
});

function scenario(checkpoints) {
  const transcript = new Transcript([{ role: 'user', content: 'source' }]);
  const memories = new Memories(transcript);
  const change = (action, memoryId, text) => ({ action, memoryId, change: 'scenario update', sourceIndexes: [0], result: { topic: 'topic', content: text, sourceIndexes: [0] } });
  const [memory] = memories.apply([change('create', null, 'first material')]);
  const firstMemory = memory.snapshot();
  assert.equal(memory.snapshot(), firstMemory); // Real entity reuses its current content.

  const facts = new Facts();
  const journal = new StudyJournal();
  const rawInput = { query: 'fixed question' };
  const input = facts.publish('I1', 'input', 'parent', rawInput);
  const captureInput = input;
  rawInput.query = 'caller changed its draft';
  assert.equal(captureInput, input);
  assert.equal(input.query, 'fixed question');

  const rawReturned = { memoryId: memory.id, material: firstMemory };
  const returned = facts.publish('O1', 'returned', 'child-1', rawReturned);
  const rawAccepted = { text: `accepted: ${returned.material.content}` };
  const accepted = facts.publish('A1', 'accepted', 'parent', rawAccepted);
  // Mutate BEFORE the first CP, not merely after a normal CP snapshot.
  rawReturned.material = { ...firstMemory, content: 'caller changed return' };
  rawAccepted.text = 'caller changed reception';
  assert.equal(returned.material.content, 'first material');
  assert.equal(accepted.text, 'accepted: first material');

  const refs = ['I1', 'O1', 'A1'];
  const state = { completed: 1 };
  const first = checkpoints ? journal.save(facts, 'after-first', state, refs) : undefined;
  const firstBundle = checkpoints ? structuredClone(journal.bundle()) : undefined;
  const encodingsBeforeSecond = journal.counts();

  memories.apply([change('update', memory.id, 'second material')]);
  const secondMemory = memory.snapshot();
  assert.notEqual(secondMemory, firstMemory);
  assert.equal(firstMemory.content, 'first material');
  assert.equal(secondMemory.content, 'second material');
  const returned2 = facts.publish('O2', 'returned', 'child-2', { memoryId: memory.id, material: secondMemory });
  facts.publish('A2', 'accepted', 'parent', { text: `accepted: ${returned2.material.content}` });
  refs.push('O2', 'A2');
  state.completed = 2;
  const second = checkpoints ? journal.save(facts, 'after-second', state, refs) : undefined;

  if (checkpoints) {
    assert.deepEqual(first.head.refs, ['I1', 'O1', 'A1']);
    assert.equal(first.head.state.completed, 1);
    assert.deepEqual(second.encoded, ['O2', 'A2']);
    for (const id of ['I1', 'O1', 'A1']) assert.equal(journal.counts()[id], encodingsBeforeSecond[id]);
    assert.equal(restoreBundle(firstBundle).records.get('O1').value.material.content, 'first material');
  } else {
    assert.deepEqual(journal.counts(), {});
  }
  // Ignore randomly generated entity ID when comparing CP on/off meanings.
  const meaning = { input: input.query, first: returned.material.content, accepted: accepted.text, second: returned2.material.content };
  return { facts, journal, meaning, first, second, firstBundle };
}

test('A candidate: one input, two children, one entity update, two CPs; data meaning is identical with CP off', (t) => {
  const without = scenario(false);
  const withCP = scenario(true);
  assert.deepEqual(without.meaning, withCP.meaning);
  assert.deepEqual(withCP.journal.counts(), { I1: 1, O1: 1, A1: 1, O2: 1, A2: 1 });
  t.diagnostic(JSON.stringify({ meaning: withCP.meaning, firstSave: withCP.first, secondSave: withCP.second, codecCalls: withCP.journal.counts() }));
});

test('A candidate: trusted fixed data can be reused, but a new consumer still checks its own contract', () => {
  const fixed = new FixedData();
  const value = fixed.own({ text: 'already fixed' });
  const visits = fixed.visits;
  assert.equal(fixed.own(value), value);
  assert.equal(fixed.visits, visits);
  let checks = 0;
  const receiver = (input, expected) => {
    checks++;
    assert.equal(input.text, expected);
    return fixed.own(input);
  };
  assert.equal(receiver(value, 'already fixed'), value);
  assert.throws(() => receiver(value, 'different contract'));
  assert.equal(checks, 2);
  // Even fully frozen foreign data has no proof in this ownership domain.
  const foreign = Object.freeze({ text: 'foreign' });
  assert.notEqual(fixed.own(foreign), foreign);
});

test('A candidate: shallow freeze is not proof, and rich/live values remain outside the experiment', () => {
  const fixed = new FixedData();
  const foreign = Object.freeze({ nested: { text: 'before' } });
  const owned = fixed.own(foreign);
  foreign.nested.text = 'after';
  assert.equal(owned.nested.text, 'before');
  const cycle = {};
  cycle.self = cycle;
  for (const value of [
    new Date(),
    new Map(),
    () => {},
    cycle,
    {
      get text() {
        assert.fail('getter must not run');
      },
    },
  ])
    assert.throws(() => fixed.own(value));
});

test('fixed failure diagnosis does not replace the original Error used by business catch', () => {
  const error = new TypeError('original error');
  const facts = new Facts();
  const diagnosis = facts.publish('F1', 'failure', 'child-1', { name: error.name, message: error.message, stack: error.stack });
  let caught;
  try {
    throw error;
  } catch (value) {
    caught = value;
  }
  error.message = 'changed later';
  error.stack = 'changed stack';
  assert.equal(caught, error);
  assert.ok(caught instanceof TypeError);
  assert.equal(diagnosis.message, 'original error');
  assert.notEqual(diagnosis.stack, error.stack);
});

test('fixing content does not prove codec round-trip semantics', () => {
  const fixed = new FixedData();
  const value = fixed.own({ text: '  meaningful spaces  ' });
  const codec = { encode: (input) => input.text, decode: (saved) => ({ text: saved.trim() }) };
  assert.notDeepEqual(codec.decode(codec.encode(value)), value);
});

test('candidate encoding failure preserves already established facts and the previous checkpoint', () => {
  const facts = new Facts();
  const journal = new StudyJournal();
  facts.publish('I1', 'input', 'parent', { query: 'question' });
  const first = journal.save(facts, 'first', null, ['I1']);
  const value = facts.publish('A1', 'accepted', 'parent', { text: 'established' });
  assert.throws(
    () =>
      journal.save(facts, 'second', null, ['I1', 'A1'], () => {
        throw new Error('codec failed');
      }),
    /codec failed/,
  );
  assert.equal(facts.get('A1').value, value);
  assert.equal(journal.bundle().head, first.head);
  assert.equal(journal.bundle().rows.length, 1);
  assert.equal(facts.pending().length, 1);
  // Does not prove production rollback, retry permission, or cross-entity atomicity.
});

test('fresh process revalidates bodies; old material survives entity updates and missing/corrupt/incompatible bodies reject', () => {
  const data = scenario(true);
  const directory = mkdtempSync(join(tmpdir(), 'capix-fixed-facts-'));
  const path = join(directory, 'bundle.json');
  const child = (bundle) => {
    writeFileSync(path, JSON.stringify(bundle), { mode: 0o600 });
    return spawnSync(process.execPath, [fileURLToPath(new URL('./restore.mjs', import.meta.url)), path], { encoding: 'utf8', timeout: 10000 });
  };
  try {
    const full = data.journal.bundle();
    const result = child(full);
    assert.equal(result.status, 0, result.stderr);
    const restored = JSON.parse(result.stdout);
    assert.ok(restored.validatedValues > 0);
    assert.equal(restored.values.O1.material.content, 'first material');
    assert.equal(restored.values.O2.material.content, 'second material');

    const missing = structuredClone(full);
    missing.rows = missing.rows.filter((row) => row.id !== 'O1');
    const unavailable = child(missing);
    assert.equal(unavailable.status, 1);
    assert.match(unavailable.stderr, /Missing fact body/);

    const corrupt = structuredClone(full);
    corrupt.rows[0].body += ' ';
    assert.match(child(corrupt).stderr, /Corrupt fact body/);

    const incompatible = structuredClone(full);
    const parsed = JSON.parse(incompatible.rows[0].body);
    parsed.codec = 'study.plain@2';
    incompatible.rows[0].body = JSON.stringify(parsed);
    incompatible.rows[0].digest = digest(incompatible.rows[0].body);
    assert.match(child(incompatible).stderr, /Incompatible codec/);

    const illegal = structuredClone(full);
    const wrong = JSON.parse(illegal.rows[0].body);
    wrong.record.value.query = 42;
    illegal.rows[0].body = JSON.stringify(wrong);
    illegal.rows[0].digest = digest(illegal.rows[0].body);
    assert.equal(child(illegal).status, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
