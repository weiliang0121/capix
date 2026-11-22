import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInThisContext } from 'node:vm';
import { useAuthorProvidedPlainObjects } from '@weiliang0121/capix-platform';
import { requireModelRequest } from '@weiliang0121/capix-model-provider';
import { createViewSource, View } from '@weiliang0121/capix-view';

const source = await readFile(new URL('./strict-inspection.js', import.meta.url), 'utf8');
const { inspectionCases } = runInThisContext(source, { filename: 'strict-inspection.js' });
const identity = { id: 'strict-inspection', scope: 'fixture' };
const key = 'example';

// A shared app bootstrap cannot disable the installed Node checks.
useAuthorProvidedPlainObjects();

function sourceRead(read) {
  const port = createViewSource({ ...identity, version: () => '1', keys: () => [key], inspect: () => 'fixture', read });
  const { stamp } = port.inspect([key]);
  return () => port.read([key], stamp);
}

function viewCapture(read, mode) {
  const stamp = { ...identity, version: '1' };
  const inspect = (keys) => ({ stamp, entries: keys.map((key) => ({ key, summary: 'fixture' })) });
  // A direct source puts the unfixed payload at the View capture boundary itself.
  const content = {
    index: () => inspect([key]),
    inspect,
    check: (expected) => expected.id === stamp.id && expected.scope === stamp.scope && expected.version === stamp.version,
    read: (keys, expected) => {
      assert.deepEqual(expected, stamp);
      return { stamp, entries: keys.map((key) => ({ key, value: read(key) })) };
    },
  };
  const view = new View({ revision: 0, sources: { content: identity }, members: [{ source: 'content', key }] });
  return () => view[mode]({ content });
}

async function checkView(prepare, input, accept) {
  let reads = 0;
  const read = (selected) => {
    assert.equal(selected, key);
    reads++;
    return { sample: input };
  };
  const operation = prepare(read);
  const wasFrozen = accept && Object.isFrozen(input);
  try {
    if (!accept) {
      await assert.rejects(async () => operation(), TypeError);
      return;
    }
    const { entries } = await operation();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].key, key);
    const { value } = entries[0];
    assert.equal(Array.isArray(value.sample), Array.isArray(input));
    assert.deepEqual(Object.entries(value.sample), Object.entries(input));
    assert.ok(Object.isFrozen(value));
    assert.ok(Object.isFrozen(value.sample));
    assert.equal(Object.isFrozen(input), wasFrozen);
    if (!wasFrozen) assert.notStrictEqual(value.sample, input);
  } finally {
    assert.equal(reads, 1);
  }
}

function checkModelRequest(input, accept) {
  const request = {
    messages: [{ role: 'user', content: 'Fixture request' }],
    tools: [{ name: 'inspect', description: 'Fixture tool', parameters: { type: 'object', properties: { sample: { examples: [input] } } } }],
  };
  if (accept) assert.strictEqual(requireModelRequest(request), request);
  else assert.throws(() => requireModelRequest(request), TypeError);
}

const boundaries = [
  ['createViewSource.read', (input, accept) => checkView(sourceRead, input, accept)],
  ['View.captureSync', (input, accept) => checkView((read) => viewCapture(read, 'captureSync'), input, accept)],
  ['View.capture', (input, accept) => checkView((read) => viewCapture(read, 'capture'), input, accept)],
  ['requireModelRequest', checkModelRequest],
];
for (const [boundary, check] of boundaries) {
  for (const { name, expected, make } of inspectionCases()) {
    test(`${boundary} handles ${name}`, async () => {
      const effects = [];
      const input = make(effects);
      const accept = expected === 'record' || expected === 'null-record' || expected === 'array';
      try {
        await check(input, accept);
      } finally {
        assert.deepEqual(effects, [], 'Inspection ran an input getter or proxy trap');
      }
    });
  }
}
