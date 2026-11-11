import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stableValue, StableValueError } from '@weiliang0121/capix-contracts';
import { FactType } from '@weiliang0121/capix-changes';

test('fact names remain optional descriptive strings without inspecting invalid inputs', () => {
  assert.equal(new FactType().name, undefined);
  assert.equal(new FactType('').name, '');
  assert.equal(new FactType('changed').name, 'changed');
  const opaque = new Proxy(
    {},
    {
      get() {
        assert.fail('invalid name inspected');
      },
    },
  );
  for (const name of [null, false, 1, Symbol('name'), {}, [], () => 'name', opaque]) assert.throws(() => new FactType(name), /name must be a string or undefined/);
});

test('facts isolate source data, hide bodies and match the exact frozen token', () => {
  const type = new FactType('revision');
  const sameName = new FactType('revision');
  const source = { revision: 1, nested: { value: 'before' } };
  const fact = type.create(source);
  assert.ok(Object.isFrozen(type));
  assert.ok(Object.isFrozen(fact));
  assert.deepEqual(Object.keys(fact), ['name']);
  assert.equal(Object.getOwnPropertySymbols(fact).length, 1);
  assert.equal(fact.name, 'revision');
  assert.equal(Object.isFrozen(source), false);
  source.nested.value = 'after';
  let received;
  assert.equal(
    type.match(fact, (event) => {
      received = event;
    }),
    true,
  );
  assert.deepEqual(received, { revision: 1, nested: { value: 'before' } });
  assert.ok(Object.isFrozen(received.nested));
  assert.equal(
    sameName.match(fact, () => assert.fail('same name must not grant access')),
    false,
  );
  assert.equal(
    type.match(fact, (event) => assert.equal(event, received)),
    true,
  );
});

test('facts reuse certified fixed values and distinguish undefined from an unknown fact', () => {
  const type = new FactType();
  const value = stableValue({ nested: { count: 1 } });
  type.match(type.create(value), (event) => assert.equal(event, value));
  assert.equal(
    type.match(type.create(undefined), (event) => assert.equal(event, undefined)),
    true,
  );
  assert.throws(() => type.create({ run() {} }), StableValueError);
});

test('fact carriers cannot silently become delivery or checkpoint values', () => {
  const type = new FactType('fixed-body');
  const fact = type.create({ count: 1 });
  for (const value of [fact, { fact }, [fact]])
    assert.throws(
      () => stableValue(value),
      (error) => error instanceof StableValueError && error.code === 'UNSUPPORTED_VALUE',
    );
  assert.equal(
    type.match(fact, (event) => assert.equal(stableValue(event), event)),
    true,
  );
  const [brand] = Object.getOwnPropertySymbols(fact);
  const copiedBrand = Object.freeze({ name: fact.name, [brand]: true });
  assert.throws(() => type.match(copiedBrand, () => assert.fail('copied brand granted body access')), /authentic Fact/);
});

test('lookalikes, inherited shells, proxies and forged tokens cannot reveal a body', () => {
  const type = new FactType('known');
  const fact = type.create({ secret: 'fixed' });
  for (const fake of [null, undefined, 1, { name: 'known' }, Object.create(fact), Object.create(Object.getPrototypeOf(fact)), new Proxy(fact, {})]) {
    assert.throws(() => type.match(fake, () => assert.fail('forged fact consumed')), /authentic Fact/);
  }
  const forgedType = Object.create(type);
  assert.throws(() => forgedType.create({ secret: 'forged' }), /authentic FactType/);
  assert.throws(() => forgedType.match(fact, () => assert.fail('forged token consumed')), /authentic FactType/);
});

test('matching preserves callback failures and throwing then accessors exactly', () => {
  const type = new FactType();
  const fact = type.create({ count: 1 });
  for (const failure of [undefined, new Error('consumer')]) {
    let caught = false;
    try {
      type.match(fact, () => {
        throw failure;
      });
    } catch (error) {
      caught = true;
      assert.equal(error, failure);
    }
    assert.ok(caught);
  }
  const failure = new Error('then getter');
  assert.throws(
    () =>
      type.match(fact, () => ({
        get then() {
          throw failure;
        },
      })),
    (error) => error === failure,
  );
  assert.equal(
    type.match(fact, () => 1),
    true,
  );
});

test('asynchronous consumers are rejected and their later rejections are consumed', async () => {
  const type = new FactType();
  const fact = type.create({ count: 1 });
  assert.throws(
    () =>
      type.match(fact, async () => {
        throw new Error('late rejection');
      }),
    /synchronously/,
  );
  let thenCalls = 0;
  assert.throws(
    () =>
      type.match(fact, () => ({
        then(resolve, reject) {
          thenCalls++;
          reject(new Error('thenable rejection'));
        },
      })),
    /synchronously/,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(thenCalls, 1);
});
