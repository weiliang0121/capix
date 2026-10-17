import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assembleRuntime } from '@capix/server-runtime';
import { runtimeDefinition } from '../fixtures/declarations.mjs';

function operation(execute) {
  return { level: 'operation', name: 'delivery', label: 'Delivery', source: 'test', children: [], maxRounds: 1, raises: [], run: { requires: {}, execute } };
}

function assemble(child, execute) {
  const execution = { level: 'execution', children: [child], maxRounds: 1, raises: [], run: { requires: {}, execute } };
  return assembleRuntime(runtimeDefinition(execution), { providers: [], source: { entry: () => null, capture: () => null } });
}

test('parent acceptance receives the exact delivery of the selected child, independently of acceptance order', async () => {
  const first = { value: 1 };
  const second = { value: 2 };
  const child = operation((work) => work.input);
  const runtime = assemble(child, async (work) => {
    const firstCall = work.children.create(child, first);
    const secondCall = work.children.create(child, second);
    await firstCall.run();
    await secondCall.run();
    const secondAccepted = await secondCall.accept(async (delivered) => {
      assert.equal(delivered, second);
      assert.equal(work.children.facts.get(secondCall.ref).reception.status, 'receiving');
      await Promise.resolve();
      return { accepted: delivered.value * 10 };
    });
    const firstAccepted = await firstCall.accept((delivered) => {
      assert.equal(delivered, first);
      return { accepted: delivered.value * 10 };
    });
    assert.equal(work.children.facts.get(firstCall.ref).returned.output, first);
    assert.equal(work.children.facts.get(secondCall.ref).returned.output, second);
    assert.equal(work.children.facts.get(firstCall.ref).reception.value, firstAccepted);
    assert.equal(work.children.facts.get(secondCall.ref).reception.value, secondAccepted);
    return [firstAccepted, secondAccepted];
  });
  assert.deepEqual(await runtime.run(null, {}), [{ accepted: 10 }, { accepted: 20 }]);
});

test('parent acceptance rejects a child that has not returned without invoking the receiver', async () => {
  const child = operation(() => assert.fail('child must remain unstarted'));
  const runtime = assemble(child, async (work) => {
    const call = work.children.create(child, null);
    await assert.rejects(
      call.accept(() => assert.fail('no delivery')),
      /has not returned successfully/,
    );
    assert.equal(work.children.facts.get(call.ref).returned, undefined);
    assert.equal(work.children.facts.get(call.ref).reception.status, 'pending');
  });
  await assert.rejects(runtime.run(null, {}), /has not returned successfully/);
});

test('parent acceptance cannot consume another parent invocation child', async () => {
  const child = operation(() => 'delivered');
  let retained;
  const owner = assemble(child, async (work) => {
    const call = work.children.create(child, null);
    retained = call.ref;
    await call.run();
    return call.accept();
  });
  assert.equal(await owner.run(null, {}), 'delivered');
  const other = assemble(child, async (work) => {
    return work.children.open(retained).accept(() => assert.fail('foreign delivery'));
  });
  await assert.rejects(other.run(null, {}), /foreign child reference/);
});

test('failed child delivery cannot be accepted after the parent catches its rejection', async () => {
  const failure = new Error('child failed');
  const child = operation(() => {
    throw failure;
  });
  const runtime = assemble(child, async (work) => {
    const call = work.children.create(child, null);
    await assert.rejects(call.run(), (error) => error === failure);
    await assert.rejects(
      call.accept(() => assert.fail('failed delivery')),
      (error) => error === failure,
    );
    assert.equal(work.children.facts.get(call.ref).returned.status, 'failed');
    assert.equal(work.children.facts.get(call.ref).reception.status, 'pending');
  });
  await assert.rejects(runtime.run(null, {}), (error) => error === failure);
});

test('a successful delivery enters parent acceptance only once', async () => {
  const delivery = { value: 1 };
  const child = operation(() => delivery);
  let received = 0;
  const runtime = assemble(child, async (work) => {
    const call = work.children.create(child, null);
    await call.run();
    const output = await call.accept((delivered) => {
      received++;
      assert.equal(delivered, delivery);
      return delivered.value;
    });
    await assert.rejects(
      call.accept(() => received++),
      /already entered acceptance/,
    );
    assert.deepEqual(work.children.facts.get(call.ref).reception, { status: 'accepted', value: output });
  });
  await assert.rejects(runtime.run(null, {}), /already entered acceptance/);
  assert.equal(received, 1);
});
