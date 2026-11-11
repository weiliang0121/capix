import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PersistenceError } from '@weiliang0121/capix-diagnostics';
import { ModelExchanges } from '@weiliang0121/capix-model-exchanges';
import { Group } from '@weiliang0121/capix-runtime';
import { Tool } from '@weiliang0121/capix-tool';
import { assembly, member, host, journal, input, reply, call, final, result } from './fixture.mjs';

for (const checkpoint of [false, true])
  test(`Tool runs two public members over multiple model steps (checkpoint=${checkpoint})`, async () => {
    const calls = [];
    const tools = Object.fromEntries(
      ['lookup', 'compare'].map((name) => [
        name,
        member(
          name,
          (value) => {
            calls.push([name, value.key]);
            return { text: `${name}:${value.key}` };
          },
          checkpoint,
        ),
      ]),
    );
    const model = host((request) => (request.exchanges.length === 0 ? reply('one', [call('a', 'lookup', { key: 'first' }), call('b', 'compare', { key: 'second' })]) : request.exchanges.length === 1 ? reply('two', [call('c', 'lookup', { key: 'third' })]) : final));
    const saves = journal();
    const fixture = assembly({ tools, policyVersion: 'v1', checkpoint }, model, { store: saves.store });
    assert.equal(fixture.entity.sequence, 0);
    assert.deepEqual(model.sent, []);
    assert.ok(fixture.tool instanceof Group);
    assert.equal(await fixture.runner.run(input), 'finished');
    assert.deepEqual(calls, [
      ['lookup', 'first'],
      ['compare', 'second'],
      ['lookup', 'third'],
    ]);
    assert.deepEqual(model.sent[1].exchanges[0].feedback, [
      { toolCallId: 'a', ...result('lookup:first') },
      { toolCallId: 'b', ...result('compare:second') },
    ]);
    assert.equal(model.sent[2].exchanges.length, 2);
    assert.deepEqual(
      model.sent[0].tools.map((tool) => tool.name),
      ['lookup', 'compare'],
    );
    assert.equal(fixture.entity.snapshot().origins.length, 1);
    assert.equal(saves.saves.length > 0, checkpoint);
    await model.interactions.settled();
    model.interactions.close();
  });

test('unknown, malformed JSON and schema mismatches close feedback without executing a member', async () => {
  let executions = 0;
  const model = host((request) => (request.exchanges.length ? final : reply('bad', [call('unknown', 'absent', {}), call('json', 'lookup', '{'), call('schema', 'lookup', { key: 9 })])));
  const fixture = assembly(
    {
      policyVersion: 'v1',
      tools: {
        lookup: member('lookup', () => {
          executions++;
          return { text: 'unexpected' };
        }),
      },
    },
    model,
  );
  assert.equal(await fixture.runner.run(input), 'finished');
  assert.equal(executions, 0);
  const feedback = model.sent[1].exchanges[0].feedback;
  assert.deepEqual(
    feedback.map((item) => item.toolCallId),
    ['unknown', 'json', 'schema'],
  );
  assert.deepEqual(
    feedback.map((item) => item.status),
    ['error', 'error', 'error'],
  );
  assert.match(feedback[0].content[0].text, /UNKNOWN_TOOL/);
  assert.match(feedback[1].content[0].text, /INVALID_ARGUMENTS/);
  await model.interactions.settled();
  model.interactions.close();
});

test('ordinary member failure uses explicit failed mapping, protected failure bypasses it', async () => {
  for (const protectedFailure of [false, true]) {
    let mapped = 0;
    const failure = protectedFailure ? new PersistenceError('TOOL_TEST_PROTECTED', 'protected fixture') : new Error('business fixture');
    const lookup = member('lookup', () => {
      throw failure;
    });
    lookup.result.failed = (error) => {
      mapped++;
      assert.equal(error, failure);
      return { status: 'error', content: [{ kind: 'text', text: 'handled' }] };
    };
    const model = host((request) => (request.exchanges.length ? final : reply('failure', [call('failed', 'lookup', { key: 'x' })])));
    const fixture = assembly({ policyVersion: 'v1', tools: { lookup } }, model);
    if (protectedFailure) await assert.rejects(fixture.runner.run(input));
    else assert.equal(await fixture.runner.run(input), 'finished');
    assert.equal(mapped, protectedFailure ? 0 : 1);
    assert.equal(model.sent.length, protectedFailure ? 1 : 2);
    await model.interactions.settled();
    model.interactions.close();
  }
});

test('result mapping failures are propagated once and cannot re-enter failed', async () => {
  let failed = 0;
  const lookup = member('lookup', () => ({ text: 'ok' }));
  lookup.result.succeeded = () => {
    throw new Error('mapping failed');
  };
  lookup.result.failed = () => {
    failed++;
    return result('incorrect');
  };
  const model = host(() => reply('map', [call('a', 'lookup', { key: 'x' })]));
  const fixture = assembly({ policyVersion: 'v1', tools: { lookup } }, model);
  await assert.rejects(fixture.runner.run(input), /mapping failed/);
  assert.equal(failed, 0);
  assert.equal(model.sent.length, 1);
  await model.interactions.settled();
  model.interactions.close();
});

test('fixed options and catalog resist later config mutation; invalid construction does not claim nodes', async () => {
  const lookup = member('lookup', () => ({ text: 'original' }));
  assert.throws(() => new Tool({ policyVersion: '', tools: { lookup } }));
  assert.throws(() => new Tool({ policyVersion: 'v1', tools: { lookup }, maxModelCalls: 0 }));
  const configuration = { policyVersion: 'v1', tools: { lookup }, maxModelCalls: 2, budgets: { maxFeedbackBytes: 1024 } };
  const model = host((request) => (request.exchanges.length ? final : reply('one', [call('a', 'lookup', { key: 'x' })])));
  const fixture = assembly(configuration, model);
  configuration.policyVersion = 'v2';
  configuration.maxModelCalls = 1;
  configuration.budgets.maxFeedbackBytes = 1;
  lookup.description = 'mutated';
  lookup.result.succeeded = () => result('mutated');
  assert.equal(await fixture.runner.run(input), 'finished');
  assert.equal(model.sent[0].tools[0].description, 'Read lookup');
  assert.equal(model.sent[1].exchanges[0].feedback[0].content[0].text, 'original');
  assert.equal(fixture.tool.catalog.policyVersion, 'v1');
  assert.throws(() => {
    fixture.tool.maxModelCalls = 9;
  });
  await model.interactions.settled();
  model.interactions.close();
});

for (const [name, configuration, mapping, expectedSends] of [
  ['model calls', { maxModelCalls: 1 }, undefined, 1],
  ['reply', { budgets: { maxReplyBytes: 32 } }, undefined, 1],
  ['feedback', { budgets: { maxFeedbackBytes: 30 } }, undefined, 1],
  ['output', {}, { maxOutputBytes: 3 }, 1],
  ['request', { budgets: { maxRequestBytes: 32 } }, undefined, 0],
  ['wire', { budgets: { maxWireRequestBytes: 32 } }, undefined, 0],
])
  test(`${name} budget fails without another model send`, async () => {
    const lookup = { ...member('lookup', () => ({ text: 'large enough output' })), ...mapping };
    const model = host(() => reply('budget', [call('a', 'lookup', { key: 'x' })]));
    const fixture = assembly({ policyVersion: 'v1', tools: { lookup }, ...configuration }, model, { inspection: { inspectRequest: (request) => ({ requestBytes: Buffer.byteLength(JSON.stringify(request)), wireBytes: Buffer.byteLength(JSON.stringify(request)) }) } });
    await assert.rejects(fixture.runner.run(input), /limit|budget|exceed/i);
    assert.equal(model.sent.length, expectedSends);
    await model.interactions.settled();
    model.interactions.close();
  });

test('shared entity supports concurrent separate Runners and repeated runs with distinct origins', async () => {
  const entity = new ModelExchanges();
  const model = host(() => final);
  const create = () => assembly({ policyVersion: 'v1', tools: { lookup: member('lookup', () => ({ text: 'unused' })) } }, model, { entity });
  const first = create();
  const second = create();
  assert.deepEqual(await Promise.all([first.runner.run(input), second.runner.run(input)]), ['finished', 'finished']);
  assert.equal(await first.runner.run(input), 'finished');
  const origins = entity.snapshot().origins;
  assert.equal(origins.length, 3);
  assert.equal(new Set(origins.map((origin) => origin.id)).size, 3);
  await model.interactions.settled();
  model.interactions.close();
});

test('cancelling a model wait releases Runner, preserves interaction, and reports cancellation', async () => {
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let deliver;
  const pending = new Promise((resolve) => {
    deliver = resolve;
  });
  const model = host(() => {
    entered();
    return pending;
  });
  const fixture = assembly({ policyVersion: 'v1', tools: { lookup: member('lookup', () => ({ text: 'unused' })) } }, model);
  const outcome = fixture.runner.run(input).catch((error) => error);
  await started;
  assert.equal(fixture.runner.cancel('stop fixture'), true);
  const error = await outcome;
  assert.equal(fixture.runner.isRunning, false);
  deliver(final);
  await model.interactions.settled();
  assert.equal(model.sent.length, 1);
  assert.equal([...model.states.values()][0].feedback.payload.id, final.id);
  model.interactions.close();
  assert.equal(error.code, 'INVOCATION_CANCELLED');
});

for (const [label, response] of [
  ['empty text', reply('empty', [{ kind: 'text', text: '   ' }])],
  ['incomplete', { ...final, termination: { kind: 'incomplete', reason: 'length' } }],
  ['refused', { ...final, termination: { kind: 'refused', reason: 'refused' } }],
])
  test(`model ${label} cannot become a successful Tool answer`, async () => {
    const model = host(() => response);
    const fixture = assembly({ policyVersion: 'v1', tools: { lookup: member('lookup', () => ({ text: 'unused' })) } }, model);
    await assert.rejects(fixture.runner.run(input));
    assert.equal(model.sent.length, 1);
    await model.interactions.settled();
    model.interactions.close();
  });

test('collection reservation rejects before model dispatch or member effects', async () => {
  let executions = 0;
  const model = host(() => final);
  const fixture = assembly(
    {
      policyVersion: 'v1',
      tools: {
        lookup: member('lookup', () => {
          executions++;
          return { text: 'unused' };
        }),
      },
      budgets: { maxCollectionBytes: 1 },
    },
    model,
  );
  await assert.rejects(fixture.runner.run(input), /collection|limit|exceed/i);
  assert.equal(executions, 0);
  assert.deepEqual(model.sent, []);
  await model.interactions.settled();
  model.interactions.close();
});

for (const checkpoint of [false, true])
  for (const toolChoice of ['auto', { name: 'lookup' }])
    test(`Tool preserves all base request options (checkpoint=${checkpoint}, choice=${JSON.stringify(toolChoice)})`, async () => {
      const request = { ...input.request, toolChoice, responseFormat: 'json_object', stream: true, maxTokens: 128, temperature: 0.25 };
      const model = host((value) => (value.exchanges.length ? final : reply('options', [call('a', 'lookup', { key: 'x' })])));
      const saves = journal();
      const fixture = assembly({ policyVersion: 'v1', checkpoint, tools: { lookup: member('lookup', (value) => ({ text: value.key }), checkpoint) } }, model, { store: saves.store });
      assert.equal(await fixture.runner.run({ request }), 'finished');
      assert.equal(model.sent.length, 2);
      for (const sent of model.sent) {
        const { tools, exchanges, ...base } = sent;
        assert.deepEqual(base, request);
        assert.deepEqual(
          tools.map((item) => item.name),
          ['lookup'],
        );
      }
      assert.equal(model.sent[1].exchanges[0].feedback[0].toolCallId, 'a');
      await model.interactions.settled();
      model.interactions.close();
    });

for (const checkpoint of [false, true])
  for (const replacement of [{ tools: [] }, { exchanges: [] }, { tools: undefined }, { exchanges: undefined }])
    test(`Tool rejects request-owned catalog/history (checkpoint=${checkpoint}, field=${Object.keys(replacement)[0]}, undefined=${Object.values(replacement)[0] === undefined})`, async () => {
      const model = host(() => final);
      const saves = journal();
      const fixture = assembly({ policyVersion: 'v1', checkpoint, tools: { lookup: member('lookup', () => ({ text: 'unused' }), checkpoint) } }, model, { store: saves.store });
      await assert.rejects(fixture.runner.run({ request: { ...input.request, ...replacement } }));
      assert.deepEqual(model.sent, []);
      assert.equal(fixture.entity.snapshot().origins.length, 0);
      await model.interactions.settled();
      model.interactions.close();
    });

for (const inspection of [undefined, { inspectRequest: () => ({ requestBytes: 1, wireBytes: 1001 }) }])
  test(`explicit wire limit requires inspection and enforces measured body bytes (inspection=${!!inspection})`, async () => {
    const model = host(() => final);
    const fixture = assembly({ policyVersion: 'v1', tools: { lookup: member('lookup', () => ({ text: 'unused' })) }, budgets: { maxWireRequestBytes: 1000 } }, model, { inspection });
    await assert.rejects(fixture.runner.run(input), inspection ? /TOOL_WIRE_REQUEST_LIMIT/ : /inspection/i);
    assert.deepEqual(model.sent, []);
    await model.interactions.settled();
    model.interactions.close();
  });
