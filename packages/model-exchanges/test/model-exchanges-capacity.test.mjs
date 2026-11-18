import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelExchanges, maximumModelExchangeEntryBytes, maximumModelExchangeOriginBytes } from '@weiliang0121/capix-model-exchanges';
import { requireModelRequest } from '@weiliang0121/capix-model-provider';

const MiB = 1024 * 1024;
const basis = { request: { messages: [{ role: 'user', content: 'small fixed origin' }] }, catalog: { tools: [], digest: 'empty', policyVersion: 'capacity.v1' } };
const reply = (id) => ({ formatVersion: 1, id, model: 'offline', output: [{ kind: 'text', text: 'x'.repeat(1100 * 1024) }], termination: { kind: 'completed', reason: 'stop' }, usage: null, native: { format: 'chat-completions', version: 1 } });

test('assembled history above 2 MiB retains exact references after JSON persistence and cold restore', () => {
  const entity = new ModelExchanges();
  const origin = entity.begin('capacity', basis);
  const exchanges = [0, 1, 2].map((index) => entity.intake(origin, { parentContextId: 'parent', childContextId: `model-${index}`, position: 'reply' }, reply(`reply-${index}`)));
  const prefix = { origin, exchanges };
  const request = entity.request(prefix);
  assert.ok(Buffer.byteLength(JSON.stringify(request)) > 3 * MiB);
  assert.doesNotThrow(() => requireModelRequest(request));
  const raw = JSON.parse(JSON.stringify(entity.snapshot()));
  const restored = ModelExchanges.restore(raw);
  assert.deepEqual(restored.request(prefix), request);
  assert.deepEqual(restored.closed(origin, exchanges), entity.closed(origin, exchanges));
  assert.deepEqual(restored.snapshot(), raw);
});

test('64 MiB request support keeps the independent 8 MiB origin and entry boundaries', () => {
  assert.equal(maximumModelExchangeOriginBytes, 8 * MiB);
  assert.equal(maximumModelExchangeEntryBytes, 8 * MiB);
  let writes = 0;
  const entity = new ModelExchanges({
    persistence: {
      commit() {
        writes++;
      },
    },
  });
  const input = { ...basis, request: { messages: [{ role: 'user', content: 'x'.repeat(8 * MiB) }] } };
  assert.doesNotThrow(() => requireModelRequest(input.request));
  assert.throws(() => entity.begin('too-large-origin', input), /byte limit|large|size/i);
  assert.equal(writes, 0);
  assert.equal(entity.sequence, 0);
  assert.deepEqual(entity.snapshot().origins, []);
});
