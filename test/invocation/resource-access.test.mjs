import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResourceAccessClosed, ResourceOffer, ResourceSupply } from '@capix/resources';
import { InvocationResources, invocationResourceFailures } from '@capix/invocation';

test('runtime phase windows share captured materials but never reopen retained endpoints', () => {
  let captures = 0;
  let exposures = 0;
  const offer = new ResourceOffer({
    timing: 'binding',
    capture(value) {
      captures++;
      return { value };
    },
    expose(material, activity) {
      exposures++;
      return { read: () => activity.runSync('read', {}, () => material) };
    },
  });
  const deps = { value: offer.request() };
  const supply = ResourceSupply.capture([offer.provide(() => 'fixed')], undefined);
  const resources = new InvocationResources(deps, supply.entries);
  resources.start();
  const original = resources.values.value;
  const material = original.read();

  resources.activate('checkpoint:resume', deps);
  const restored = resources.view(deps, 'checkpoint:resume').value;
  assert.notEqual(restored, original);
  assert.equal(restored.read(), material);
  assert.equal(captures, 1);
  assert.equal(exposures, 2);
  assert.throws(() => original.read(), ResourceAccessClosed);

  resources.closeAll();
  assert.throws(() => restored.read(), ResourceAccessClosed);
  assert.throws(() => resources.activate('checkpoint:resume', deps), ResourceAccessClosed);
});

test('runtime fixes resource owner ports when attaching, before opening a phase', () => {
  const offer = new ResourceOffer({ expose: (value, activity) => ({ read: () => activity.runSync('read', {}, () => value) }) });
  const deps = { value: offer.request() };
  const resources = new InvocationResources(deps, ResourceSupply.capture([offer.provide(() => 7)], undefined).entries);
  let validations = 0;
  const owner = {
    contextId: 'owner',
    failures: invocationResourceFailures,
    round: () => 1,
    validate() {
      validations++;
    },
  };
  resources.attach(owner);
  owner.validate = () => {
    throw new Error('replacement validator');
  };
  owner.round = () => {
    throw new Error('replacement round');
  };
  resources.start();
  assert.equal(resources.values.value.read(), 7);
  assert.ok(validations > 0);
});

test('a closed runtime phase cannot be reactivated through a new named view', () => {
  const offer = new ResourceOffer({ methods: { read: (value) => value } });
  const deps = { value: offer.request() };
  const resources = new InvocationResources(deps, ResourceSupply.capture([offer.provide(() => 'value')], undefined).entries);
  resources.start();
  resources.close('run');
  assert.throws(() => resources.view(deps).value, ResourceAccessClosed);
  assert.throws(() => resources.activate('run', deps), ResourceAccessClosed);
});
