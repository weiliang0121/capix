import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelExchanges } from '@weiliang0121/capix-model-exchanges';
import { GeminiGenerateContentProvider } from '@weiliang0121/capix-model-provider';

for (const vendorIds of [[], ['vendor-id']])
  test(`Gemini restores same-name calls with ${vendorIds.length} supplied wire ID and reverse feedback`, async () => {
    const requests = [];
    const parts = ['left', 'right'].map((key, i) => ({ functionCall: { name: 'lookup', args: { key }, ...(vendorIds[i] ? { id: vendorIds[i] } : {}) }, ...(i === 0 ? { thoughtSignature: 'c2ln' } : {}) }));
    const model = 'local-model';
    const provider = new GeminiGenerateContentProvider({
      endpoint: 'https://gemini.invalid/v1beta/models/local-model:generateContent',
      apiKey: 'offline',
      bindingId: 'exchange-tests',
      model,
      fetch: async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return Response.json({ candidates: [{ index: 0, content: { role: 'model', parts: requests.length === 1 ? parts : [{ text: 'done' }] }, finishReason: 'STOP' }] });
      },
    });
    const entity = new ModelExchanges();
    const origin = entity.begin('parallel', { request: { messages: [{ role: 'user', content: 'Find both records' }] }, catalog: { digest: 'catalog', policyVersion: '1', tools: [{ name: 'lookup', description: 'Look up a record', parameters: { type: 'object' } }] } });
    const reply = await provider.complete(entity.request({ origin, exchanges: [] }));
    const [left, right] = reply.output;
    assert.equal(reply.native.idSource, 'local');
    assert.equal(reply.native.modelSource, 'configured');
    assert.notEqual(left.id, right.id);
    if (vendorIds.length) assert.notEqual(left.id, vendorIds[0]);
    const open = entity.intake(origin, { parentContextId: 'parent', childContextId: 'model', position: 'receive' }, reply);
    const feedback = (text) => ({ status: 'ok', content: [{ kind: 'text', text }] });
    if (vendorIds.length) assert.throws(() => entity.complete(origin, open, vendorIds[0], feedback('foreign')));
    const partial = entity.complete(origin, open, right.id, feedback('second fact'));
    assert.throws(() => entity.request({ origin, exchanges: [partial] }));
    const reopened = ModelExchanges.restore(JSON.parse(JSON.stringify(entity.snapshot())));
    const closed = reopened.complete(origin, partial, left.id, feedback('first fact'));
    const snapshot = JSON.parse(JSON.stringify(reopened.snapshot()));
    const restored = ModelExchanges.restore(snapshot, { persistence: { commit: () => assert.fail('restore wrote snapshot') } });
    const request = restored.request({ origin, exchanges: [closed] });
    assert.deepEqual(
      request.exchanges[0].feedback.map((item) => item.toolCallId),
      [right.id, left.id],
    );
    assert.deepEqual(request.exchanges[0].reply, reply);
    await provider.complete(request);
    const wire = JSON.stringify(requests[1]);
    for (const localId of [reply.id, left.id, right.id]) assert.ok(!wire.includes(localId));
    const [assistant, user] = requests[1].contents.slice(-2);
    assert.deepEqual(assistant, { role: 'model', parts });
    assert.equal(user.role, 'user');
    assert.deepEqual(
      user.parts.map(({ functionResponse }) => functionResponse.name),
      ['lookup', 'lookup'],
    );
    for (const [i, label] of ['first fact', 'second fact'].entries()) {
      const response = user.parts[i].functionResponse;
      assert.equal(response.id, vendorIds[i]);
      assert.ok(JSON.stringify(response.response).includes(label));
    }
    const invalid = structuredClone(snapshot);
    invalid.entries[0].reply.native.parts[1].index = 0;
    const before = structuredClone(invalid);
    assert.throws(() => ModelExchanges.restore(invalid));
    assert.deepEqual(invalid, before);
  });
