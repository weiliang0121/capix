import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelExchanges } from '@weiliang0121/capix-model-exchanges';
import { OpenAIResponsesProvider } from '@weiliang0121/capix-model-provider';

for (const continuation of ['replay', 'previous-response-id'])
  test(`Responses ${continuation} preserves distinct response, item and call IDs across a snapshot and reverse feedback`, async () => {
    const sent = [];
    const route = { endpoint: 'https://exchange.invalid/v1/responses', apiKey: 'offline', bindingId: 'gateway-A', model: 'alias', continuation };
    const items = ['a', 'b'].map((key) => ({ type: 'function_call', id: 'fc_' + key, call_id: 'call_' + key, name: 'lookup', arguments: JSON.stringify({ key }), status: 'completed' }));
    const provider = new OpenAIResponsesProvider({
      ...route,
      fetch: async (_url, { body }) => {
        const wire = JSON.parse(body);
        sent.push(wire);
        return Response.json({ object: 'response', id: sent.length === 1 ? 'resp_batch' : 'resp_next', model: 'alias', status: 'completed', error: null, incomplete_details: null, store: wire.store, previous_response_id: wire.previous_response_id ?? null, output: sent.length === 1 ? items : [{ type: 'message', id: 'msg_done', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] }] });
      },
    });
    const exchanges = new ModelExchanges();
    const origin = exchanges.begin('batch', {
      request: {
        messages: [
          { role: 'system', content: 'Check catalogued records.' },
          { role: 'user', content: 'Look up both records.' },
        ],
      },
      catalog: { digest: 'catalog', policyVersion: '1', tools: [{ name: 'lookup', description: 'Look up a record', parameters: { type: 'object' } }] },
    });
    const reply = await provider.complete(exchanges.request({ origin, exchanges: [] }));
    const opened = exchanges.intake(origin, { parentContextId: 'parent', childContextId: 'model', position: 'receive' }, reply);
    const feedback = (text) => ({ status: 'ok', content: [{ kind: 'text', text }] });
    assert.throws(() => exchanges.complete(origin, opened, 'fc_b', feedback('b')));
    const partial = exchanges.complete(origin, opened, 'call_b', feedback('b'));
    assert.throws(() => exchanges.request({ origin, exchanges: [partial] }));
    const closed = exchanges.complete(origin, partial, 'call_a', feedback('a'));
    const snapshot = JSON.parse(JSON.stringify(exchanges.snapshot()));
    assert.equal(snapshot.formatVersion, 2);
    const restored = ModelExchanges.restore(snapshot, { persistence: { commit: () => assert.fail('offline restore performed a write') } });
    assert.deepEqual(restored.snapshot(), snapshot);
    const request = restored.request({ origin, exchanges: [closed] });
    assert.equal(request.exchanges[0].reply.id, 'resp_batch');
    assert.deepEqual(
      request.exchanges[0].feedback.map((item) => item.toolCallId),
      ['call_b', 'call_a'],
    );
    await provider.complete(request);
    const next = sent[1];
    assert.deepEqual(next.tools, sent[0].tools);
    assert.match(JSON.stringify(sent[0]), /Check catalogued records/);
    if (continuation === 'replay' || sent[0].instructions) assert.match(JSON.stringify(next), /Check catalogued records/);
    else assert.ok(!JSON.stringify(next.input).includes('Check catalogued records.'));
    assert.deepEqual(
      next.input.filter((item) => item.type === 'function_call_output').map((item) => item.call_id),
      ['call_a', 'call_b'],
    );
    assert.equal(next.previous_response_id, continuation === 'previous-response-id' ? 'resp_batch' : undefined);
    const invalid = structuredClone(snapshot);
    invalid.entries[0].reply.native.version = 999;
    const original = structuredClone(invalid);
    assert.throws(() => ModelExchanges.restore(invalid));
    assert.deepEqual(invalid, original);
  });
