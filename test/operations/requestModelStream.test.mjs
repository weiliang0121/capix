import { installCallable } from '../fixtures/driver.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineScene, defineGroup } from '@capix/server-runtime';
import { RequestModelDefinition, ModelResource, ModelSettingsResource } from '@capix/observer-service/conversation';

test('request-model keeps its progress subscription until the follow child returns', async () => {
  const model = new RequestModelDefinition('answer');
  const events = [];
  const request = { model: 'fixture', messages: [], response_format: { type: 'json_object' }, thinking: { type: 'disabled' }, max_tokens: 256, stream: true };
  const output = { id: 'reply', model: 'fixture', content: 'earlylate', finishReason: 'stop', usage: null };
  const reference = { id: 'interaction' };
  let receiver;
  let subscribed = false;
  let detachCount = 0;
  let starts = 0;
  const interactions = {
    start() {
      starts += 1;
      return reference;
    },
    subscribe(_ref, consumer) {
      receiver = consumer;
      subscribed = true;
      receiver.receive({ text: 'early' });
      return () => {
        detachCount += 1;
        subscribed = false;
      };
    },
    async wait() {
      return { kind: 'pending', interaction: reference };
    },
    async result() {
      await new Promise(setImmediate);
      if (subscribed) receiver.receive({ text: 'late' });
      return output;
    },
  };
  const execution = defineGroup()({
    members: [model],
    run: {
      requires: RequestModelDefinition.requires,
      async execute(work) {
        const call = work.children.create(model, work.input, {
          output: {
            receive: (event) => {
              events.push(event);
            },
          },
        });
        await call.run();
        return call.accept();
      },
    },
  });
  const root = defineScene()({
    members: [execution],
    run: {
      async execute(work) {
        const call = work.children.create(execution, work.input);
        await call.run();
        return call.accept();
      },
    },
  });
  const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 256, timeoutMs: 1000 };
  const runtime = installCallable(root, {
    providers: [ModelSettingsResource.snapshot.provide(() => settings), ModelSettingsResource.timeout.provide(() => settings.timeoutMs), ModelResource.create.provide(() => interactions), ModelResource.read.provide(() => interactions)],
    source: { entry: () => null, capture: () => null },
  });
  assert.equal(await runtime.run(request, {}), output);
  assert.equal(starts, 1);
  assert.equal(detachCount, 1);
  assert.equal(subscribed, false);
  assert.deepEqual(
    events.filter((event) => event.kind === 'delta').map((event) => event.delta.text),
    ['early', 'late'],
  );
});
