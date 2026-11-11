import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FactType, publishFact, ChangeCaptureError } from '@weiliang0121/capix-changes';
import { Resource, ResourceOffer, Resources, ResourceAccessClosed, ResourcePortError } from '@weiliang0121/capix-resources';

const changed = new FactType('business.changed');
const failures = { isProtected: () => false, isCancellation: () => false, describe: () => null };

function open(offer, owner = {}, entity = {}) {
  const observations = [];
  const facts = [];
  const binding = new Resources().register(new Resource(entity), offer).bind({ entity: offer.request() });
  const access = binding.open({ contextId: 'owner', failures, validate() {}, observation: { publish: (value) => void observations.push(value) }, facts: { publish: (value) => void facts.push(value) }, ...owner });
  return { access, endpoint: access.endpoints.entity, observations, facts };
}

test('synchronous facts keep their own operation identity and fixed producer body', () => {
  const source = { revision: 1, value: { text: 'original' } };
  let publisher;
  let operation;
  const offer = new ResourceOffer({
    expose(_entity, activity) {
      return {
        change: () =>
          activity.runSync('change', {}, (current) => {
            operation = current;
            publisher = current.facts(changed);
            publisher.publish(source);
            source.value.text = 'mutated';
            return 7;
          }),
      };
    },
  });
  const { access, endpoint, observations, facts } = open(offer);
  assert.equal(endpoint.change(), 7);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].operationId, observations.find((fact) => fact.phase === 'started').interactionId);
  assert.equal(facts[0].contextId, operation.origin.contextId);
  assert.equal(facts[0].offerId, offer.id);
  assert.equal(facts[0].supplyId, observations[0].supplyId);
  changed.match(facts[0].fact, (value) => {
    assert.equal(value.value.text, 'original');
    assert.ok(!('origin' in value), 'forwarding must not rewrite domain provenance');
    assert.ok(Object.isFrozen(value.value));
  });
  assert.throws(() => publisher.publish(source), ResourceAccessClosed);
  assert.throws(() => operation.facts(changed), ResourceAccessClosed);
  assert.equal(facts.length, 1);
  access.close();
});

test('asynchronous facts stop before result reception and remain closed after window exit', async () => {
  let publisher;
  const offer = new ResourceOffer({
    methods: {
      change(_entity, _input, operation) {
        publisher = operation.facts(changed);
        publisher.publish({ revision: 1 });
        return 1;
      },
    },
  });
  const { access, endpoint, facts } = open(offer);
  assert.equal(
    await endpoint.change(undefined, {
      result: {
        succeeded(value) {
          assert.throws(() => publisher.publish({ revision: 2 }), ResourceAccessClosed);
          return value;
        },
      },
    }),
    1,
  );
  access.close();
  assert.throws(() => publisher.publish({ revision: 2 }), ResourceAccessClosed);
  assert.equal(facts.length, 1);
});

test('window closure blocks in-flight fact delivery without ending external work early', async () => {
  const gate = Promise.withResolvers();
  let publisher;
  let settled = false;
  const offer = new ResourceOffer({
    methods: {
      async change(_entity, _input, operation) {
        publisher = operation.facts(changed);
        await gate.promise;
        return 'late';
      },
    },
  });
  const { access, endpoint, facts } = open(offer);
  const pending = endpoint.change().finally(() => {
    settled = true;
  });
  const rejected = assert.rejects(pending, ResourceAccessClosed);
  access.close();
  assert.equal(settled, false);
  assert.throws(() => publisher.publish({ revision: 1 }), ResourceAccessClosed);
  gate.resolve();
  await rejected;
  assert.equal(facts.length, 0);
});

test('capture failure still forwards the committed fact before the resource throws', () => {
  const cause = new Error('required capture failed');
  let applied = false;
  const offer = new ResourceOffer({
    expose(_entity, activity) {
      return {
        change: () =>
          activity.runSync('change', {}, (operation) => {
            applied = true;
            publishFact(
              { revision: 1 },
              {
                capture() {
                  throw cause;
                },
              },
              operation.facts(changed),
            );
          }),
      };
    },
  });
  const { access, endpoint, facts, observations } = open(offer);
  assert.throws(() => endpoint.change(), ChangeCaptureError);
  assert.equal(applied, true);
  assert.equal(facts.length, 1);
  assert.equal(observations.at(-1).phase, 'threw');
  access.close();
});

test('confirming an earlier effect does not manufacture a second domain change', async () => {
  let receipt;
  const offer = new ResourceOffer({
    methods: {
      apply(_entity, _input, operation) {
        if (receipt) return { status: 'confirmed', receipt };
        receipt = { revision: 1 };
        publishFact(receipt, undefined, operation.facts(changed));
        return { status: 'applied', receipt };
      },
    },
  });
  const { access, endpoint, facts, observations } = open(offer);
  assert.equal((await endpoint.apply()).status, 'applied');
  assert.equal((await endpoint.apply()).status, 'confirmed');
  assert.equal(observations.filter((fact) => fact.phase === 'returned').length, 2);
  assert.equal(facts.length, 1);
  access.close();
});

test('reentry during fixing or host sequencing cannot publish into a closed operation', () => {
  for (const mode of ['fix', 'sequence']) {
    let access;
    let closeFromSequence = false;
    const offer = new ResourceOffer({
      expose(_entity, activity) {
        return {
          change: () =>
            activity.runSync('change', {}, (operation) => {
              const publisher = operation.facts(changed);
              closeFromSequence = true;
              const value =
                mode === 'fix'
                  ? new Proxy(
                      {},
                      {
                        ownKeys(target) {
                          access.close();
                          return Reflect.ownKeys(target);
                        },
                      },
                    )
                  : {};
              publisher.publish(value);
            }),
        };
      },
    });
    let sequence = 0;
    const result = open(offer, {
      nextSequence() {
        if (mode === 'sequence' && closeFromSequence) access.close();
        return ++sequence;
      },
    });
    access = result.access;
    assert.throws(
      () => result.endpoint.change(),
      (error) => error instanceof ResourceAccessClosed || (error instanceof AggregateError && error.errors.every((cause) => cause instanceof ResourceAccessClosed)),
    );
    assert.equal(result.facts.length, 0);
    access.close();
  }
});

test('invalid domain data is a protected publication fault after the actual effect', async () => {
  let applied = false;
  let fallback = false;
  const reported = [];
  const offer = new ResourceOffer({
    methods: {
      change(_entity, _input, operation) {
        applied = true;
        operation.facts(changed).publish({ capability() {} });
        return 'wrong';
      },
    },
  });
  const { access, endpoint, facts } = open(offer, { error: (error) => void reported.push(error) });
  await assert.rejects(
    endpoint.change(undefined, {
      result: {
        failed() {
          fallback = true;
        },
      },
    }),
    ResourcePortError,
  );
  assert.equal(applied, true);
  assert.equal(fallback, false);
  assert.equal(facts.length, 0);
  assert.ok(reported.some((error) => error instanceof ResourcePortError));
  access.close();
});

test('unobserved operations neither construct facts nor infer a calling origin', async () => {
  const offer = new ResourceOffer({
    methods: {
      read(_entity, _input, operation) {
        assert.equal(operation.origin, undefined);
        assert.equal(operation.facts(changed), undefined);
        return 1;
      },
    },
  });
  const access = new Resources().register(new Resource({}), offer).bind({ entity: offer.request() }).open();
  assert.equal(await access.endpoints.entity.read(), 1);
  access.close();
});

test('a reentrant validator cannot deliver a fact after closing or aborting the operation', () => {
  for (const mode of ['close', 'abort']) {
    const controller = new AbortController();
    let access;
    let armed = false;
    let visits = 0;
    const offer = new ResourceOffer({
      expose(_entity, activity) {
        return {
          change: () =>
            activity.runSync('change', {}, (operation) => {
              const publisher = operation.facts(changed);
              armed = true;
              publisher.publish({ revision: 1 });
            }),
        };
      },
    });
    const result = open(offer, {
      signal: controller.signal,
      validate() {
        if (!armed || ++visits !== 2) return;
        if (mode === 'close') access.close();
        else controller.abort(new ResourceAccessClosed('aborted in validator'));
      },
    });
    access = result.access;
    assert.throws(() => result.endpoint.change());
    assert.equal(result.facts.length, 0);
    access.close();
  }
});
