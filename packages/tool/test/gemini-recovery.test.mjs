import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelExchanges } from '@weiliang0121/capix-model-exchanges';
import { GeminiGenerateContentProvider } from '@weiliang0121/capix-model-provider';
import { assembly, host, input, journal, member } from './fixture.mjs';

const route = { endpoint: 'https://gateway.invalid/v1beta/models/local-model:generateContent', model: 'local-model', bindingId: 'workspace-gateway', apiKey: 'offline' };
const calls = [{ thoughtSignature: 'c2ln', functionCall: { name: 'lookup', args: { key: 'A' } } }, { functionCall: { name: 'lookup', id: 'from-gemini', args: { key: 'B' } } }];
function response(round) {
  return Response.json({ ...(round > 1 ? { responseId: 'reply-' + round, modelVersion: route.model } : {}), candidates: [{ index: 0, content: { role: 'model', parts: round === 1 ? calls : [{ text: 'done' }] }, finishReason: 'STOP' }] });
}
function config(run) {
  return { policyVersion: 'gemini-lookup', tools: { lookup: member('lookup', run, true) }, checkpoint: true };
}

test('Gemini Tool replays two real lookup results, then cold-confirms their completed checkpoint', async () => {
  const requests = [];
  const effects = [];
  const provider = new GeminiGenerateContentProvider({
    ...route,
    fetch: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      assert.ok(requests.length <= 2);
      return response(requests.length);
    },
  });
  const sender = host((request) => provider.complete(request));
  let partial;
  const saves = journal((commit, count) => {
    if (partial || commit.contract.key !== 'capix.tool' || commit.point !== 'tools') return;
    const snapshot = scene.entity.snapshot();
    if (snapshot.entries[0]?.feedback.length === 1) partial = { count, snapshot: structuredClone(snapshot), states: structuredClone(sender.states) };
  });
  const scene = assembly(
    config(({ key }) => {
      effects.push(key);
      return { text: 'result ' + key };
    }),
    sender,
    { store: saves.store, inspection: provider },
  );
  try {
    assert.equal(await scene.runner.run(input), 'done');
    assert.deepEqual(effects, ['A', 'B']);
    assert.equal(requests.length, 2);
    const [assistant, feedback] = requests[1].contents.slice(-2);
    assert.deepEqual(assistant.parts, calls);
    const results = feedback.parts.map((part) => part.functionResponse);
    assert.deepEqual(
      results.map((item) => item.id),
      [undefined, 'from-gemini'],
    );
    for (const [index, key] of effects.entries()) assert.ok(JSON.stringify(results[index].response).includes('result ' + key));
  } finally {
    await sender.interactions.settled();
    sender.interactions.close();
  }
  assert.ok(partial);
  const savedReply = partial.snapshot.entries[0].reply;
  assert.equal(savedReply.native.idSource, 'local');
  assert.equal(savedReply.native.modelSource, 'configured');
  const resumedEffects = [];
  const nextProvider = new GeminiGenerateContentProvider({
    ...route,
    fetch: async (_url, init) => {
      assert.deepEqual(JSON.parse(init.body), requests[1]);
      return response(2);
    },
  });
  const nextHost = host((request) => nextProvider.complete(request), partial.states);
  const resumed = assembly(
    config(({ key }) => {
      resumedEffects.push(key);
      return { text: 'result ' + key };
    }),
    nextHost,
    { store: saves.replay(partial.count), entity: ModelExchanges.restore(partial.snapshot), inspection: nextProvider },
  );
  try {
    assert.equal(await resumed.runner.resume(saves.contextId), 'done');
    assert.deepEqual(resumedEffects, ['B']);
    assert.equal(nextHost.sent.length, 1);
  } finally {
    await nextHost.interactions.settled();
    nextHost.interactions.close();
  }
  const snapshot = JSON.parse(JSON.stringify(scene.entity.snapshot()));
  for (const changeSignature of [false, true]) {
    const states = structuredClone(sender.states);
    if (changeSignature) {
      const first = [...states.values()].find((state) => state.feedback.payload.id === savedReply.id);
      first.feedback.payload.native.parts[0].thoughtSignature = 'bmV3';
    }
    const cold = host(() => assert.fail('resent model request'), states);
    const restored = assembly(
      config(() => assert.fail('repeated tool')),
      cold,
      { store: saves.replay(), entity: ModelExchanges.restore(snapshot) },
    );
    try {
      if (changeSignature) await assert.rejects(restored.runner.resume(saves.contextId));
      else assert.equal(await restored.runner.resume(saves.contextId), 'done');
      assert.deepEqual(cold.sent, []);
      assert.deepEqual(restored.entity.snapshot(), snapshot);
    } finally {
      await cold.interactions.settled();
      cold.interactions.close();
    }
  }
});

test('Gemini Tool rejects a proposed call from a different binding before dispatching its member', async () => {
  let attempts = 0;
  let effects = 0;
  const producer = new GeminiGenerateContentProvider({ ...route, bindingId: 'other-gateway', fetch: async () => response(++attempts) });
  const inspector = new GeminiGenerateContentProvider({ ...route, fetch: () => assert.fail('inspection sent a request') });
  const sender = host((request) => producer.complete(request));
  const configuration = config(() => {
    effects++;
    return { text: 'unexpected' };
  });
  const scene = assembly(configuration, sender, { store: journal().store, inspection: inspector });
  try {
    await assert.rejects(scene.runner.run(input));
    assert.equal(attempts, 1);
    assert.equal(effects, 0);
    assert.deepEqual(scene.entity.values()[0].feedback, []);
  } finally {
    await sender.interactions.settled();
    sender.interactions.close();
  }
});
