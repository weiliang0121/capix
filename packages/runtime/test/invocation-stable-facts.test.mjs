import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Scene, Resources, Runner, CallableInvocationBuilder } from '@weiliang0121/capix-runtime';

import { ResourceOffer, ResourceSupply } from '@weiliang0121/capix-resources';

import { installCallable } from './fixtures/driver.mjs';

test('Runner fixes input before resource capture and passes that same fact to Work', async () => {
  const raw = { text: ['original'] };
  let captured;
  const offer = new ResourceOffer({ methods: { read: (source) => source } });
  const scene = new Scene({
    deps: { source: offer.request() },
    run: (work) => {
      assert.equal(work.input, captured);
      return work.resources.source.read();
    },
  });
  const resources = new Resources();
  resources
    .capture(scene, (input) => {
      captured = input;
      assert.notEqual(input, raw);
      assert.throws(() => input.text.push('mutation'), TypeError);
      raw.text[0] = 'changed during capture';
      return input;
    })
    .register(offer, (input) => input);
  assert.deepEqual(await new Runner(scene, resources).build().run(raw), { text: ['original'] });
});

test('low-level builder fixes input before resource refinement', async () => {
  const raw = { scope: ['initial'] };
  let refined;
  const offer = new ResourceOffer({ expose: (source) => source, refine: (_source, selection) => selection });
  const supply = ResourceSupply.capture([offer.provide(() => null)], undefined);
  const builder = new CallableInvocationBuilder();
  const call = builder.create(raw, {
    kind: 'node',
    supplied: supply,
    deps: { value: offer.request() },
    refinements: [
      offer.refine((input) => {
        refined = input;
        assert.throws(() => input.scope.push('mutation'), TypeError);
        raw.scope[0] = 'changed during refine';
        return input.scope;
      }),
    ],
    work: { execute: (context) => context.input },
  });
  assert.equal(call.context.input, refined);
  assert.deepEqual(await call.run(), { scope: ['initial'] });
});

test('legacy source capture also receives the fixed invocation input', async () => {
  const raw = { text: 'original' };
  let captured;
  const scene = new Scene({ run: (work) => work.input });
  const runtime = installCallable(scene, {
    providers: [],
    source: {
      capture(input) {
        captured = input;
        assert.notEqual(input, raw);
        assert.ok(Object.isFrozen(input));
        raw.text = 'changed during legacy capture';
        return null;
      },
    },
  });
  const result = await runtime.run(raw, {});
  assert.equal(result, captured);
  assert.deepEqual(result, { text: 'original' });
});
