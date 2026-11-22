import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

test('default Tool comparison dispatches plain arguments and rejects getters without reading them', async (t) => {
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      return nextResolve(specifier, { ...context, conditions: context.conditions.filter((condition) => condition !== 'node') });
    },
  });
  t.after(() => hook.deregister());
  const { useAuthorProvidedPlainObjects } = await import('@weiliang0121/capix-platform');
  useAuthorProvidedPlainObjects();
  const { assembly, member, schemaWithArgumentGetter, host, input, reply, call, final, result } = await import('./fixture.mjs');
  const args = { key: 'fixed' };
  const lookupCall = call('a', 'lookup', args);

  await t.test('ordinary schema', async (t) => {
    const model = host((request) => (request.exchanges.length ? final : reply('plain', [lookupCall])));
    t.after(async () => {
      await model.interactions.settled();
      model.interactions.close();
    });
    const inputs = [];
    const lookup = member('lookup', (value) => {
      inputs.push(value);
      return { text: value.key };
    });
    const fixture = assembly({ policyVersion: 'plain-argument.v1', tools: { lookup } }, model);
    const selected = fixture.tool.checkToolCall(lookupCall);
    assert.equal(selected.kind, 'accepted');
    assert.deepEqual(selected.input, args);
    assert.equal(await fixture.runner.run(input), 'finished');
    assert.deepEqual(inputs, [args]);
    assert.deepEqual(model.sent[1].exchanges[0].feedback, [{ toolCallId: 'a', ...result('fixed') }]);
  });

  await t.test('same-value accessor schema', async (t) => {
    const model = host(() => reply('accessor', [lookupCall]));
    t.after(async () => {
      await model.interactions.settled();
      model.interactions.close();
    });
    let reads = 0;
    const lookup = member('lookup', () => assert.fail('accessor argument executed'));
    lookup.input = schemaWithArgumentGetter(() => reads++);
    const fixture = assembly({ policyVersion: 'argument-getter.v1', tools: { lookup } }, model);
    const failure = { name: 'TypeError', message: 'Tool input schema must preserve the fixed model arguments' };

    assert.throws(() => fixture.tool.checkToolCall(lookupCall), failure);
    await assert.rejects(fixture.runner.run(input), failure);
    assert.equal(reads, 0);
    assert.equal(model.sent.length, 1);
    assert.deepEqual(fixture.entity.snapshot().entries[0].feedback, []);
  });
});
