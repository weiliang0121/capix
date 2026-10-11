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
  const child = operation((context) => context.currentInput);
  const runtime = assemble(child, async (_context, parent, children) => {
    const firstCall = children.get(child).create(parent, first);
    const secondCall = children.get(child).create(parent, second);
    await firstCall.run();
    await secondCall.run();
    const secondAccepted = await children.accept(secondCall, async (delivered) => {
      assert.equal(delivered, second);
      assert.equal(parent.children.get(secondCall).reception.status, 'receiving');
      await Promise.resolve();
      return { accepted: delivered.value * 10 };
    });
    const firstAccepted = await children.accept(firstCall, (delivered) => {
      assert.equal(delivered, first);
      return { accepted: delivered.value * 10 };
    });
    assert.equal(parent.children.get(firstCall).returned.output, first);
    assert.equal(parent.children.get(secondCall).returned.output, second);
    assert.equal(parent.children.get(firstCall).reception.output, firstAccepted);
    assert.equal(parent.children.get(secondCall).reception.output, secondAccepted);
    return [firstAccepted, secondAccepted];
  });
  assert.deepEqual(await runtime.run(null, {}), [{ accepted: 10 }, { accepted: 20 }]);
});

test('parent acceptance rejects a child that has not returned without invoking the receiver', async () => {
  const child = operation(() => assert.fail('child must remain unstarted'));
  const runtime = assemble(child, async (_context, parent, children) => {
    const call = children.get(child).create(parent, null);
    await assert.rejects(
      children.accept(call, () => assert.fail('no delivery')),
      /has not returned successfully/,
    );
    assert.equal(parent.children.get(call).returned, undefined);
    assert.equal(parent.children.get(call).reception.status, 'pending');
  });
  await assert.rejects(runtime.run(null, {}), /has not returned successfully/);
});

test('parent acceptance cannot consume another parent invocation child', async () => {
  const child = operation(() => 'delivered');
  let retained;
  const owner = assemble(child, async (_context, parent, children) => {
    retained = children.get(child).create(parent, null);
    await retained.run();
    return children.accept(retained, (delivered) => delivered);
  });
  assert.equal(await owner.run(null, {}), 'delivered');
  const other = assemble(child, async (_context, _parent, children) => {
    return children.accept(retained, () => assert.fail('foreign delivery'));
  });
  await assert.rejects(other.run(null, {}), /not a child created through this binding/);
});

test('failed child delivery cannot be accepted after the parent catches its rejection', async () => {
  const failure = new Error('child failed');
  const child = operation(() => {
    throw failure;
  });
  const runtime = assemble(child, async (_context, parent, children) => {
    const call = children.get(child).create(parent, null);
    await assert.rejects(call.run(), (error) => error === failure);
    await assert.rejects(
      children.accept(call, () => assert.fail('failed delivery')),
      (error) => error === failure,
    );
    assert.equal(parent.children.get(call).returned.status, 'failed');
    assert.equal(parent.children.get(call).reception.status, 'pending');
  });
  await assert.rejects(runtime.run(null, {}), (error) => error === failure);
});

test('a successful delivery enters parent acceptance only once', async () => {
  const delivery = { value: 1 };
  const child = operation(() => delivery);
  let received = 0;
  const runtime = assemble(child, async (_context, parent, children) => {
    const call = children.get(child).create(parent, null);
    await call.run();
    const output = await children.accept(call, (delivered) => {
      received++;
      assert.equal(delivered, delivery);
      return delivered.value;
    });
    await assert.rejects(
      children.accept(call, () => received++),
      /already entered acceptance/,
    );
    assert.deepEqual(parent.children.get(call).reception, { status: 'accepted', output });
  });
  await assert.rejects(runtime.run(null, {}), /already entered acceptance/);
  assert.equal(received, 1);
});
