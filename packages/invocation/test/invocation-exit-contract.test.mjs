import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Invocation, InvocationContext } from '@weiliang0121/capix-invocation';

test('low-level Invocation drains an explicitly started reception before becoming terminal', async () => {
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const events = [];
  let child;
  let reception;
  const parent = new Invocation({
    context: new InvocationContext(null),
    signal: new AbortController().signal,
    work: {
      async execute(_context, invocation) {
        child = new Invocation({ context: new InvocationContext(null), signal: new AbortController().signal, parent: { invocation }, work: { execute: () => 'child' } });
        await child.run();
        reception = invocation.children.get(child).accept(async () => {
          entered.resolve();
          await finish.promise;
          events.push('accepted');
          return 'accepted';
        });
        events.push('body-exit');
        return 'parent';
      },
    },
  });
  let settled = false;
  const pending = parent.run().then((value) => {
    settled = true;
    return value;
  });
  await entered.promise;
  assert.equal(settled, false);
  assert.equal(parent.context.status, 'running');
  assert.equal(parent.children.get(child).reception.status, 'receiving');
  finish.resolve();
  assert.equal(await reception, 'accepted');
  assert.equal(await pending, 'parent');
  assert.deepEqual(events, ['body-exit', 'accepted']);
  assert.equal(parent.context.status, 'succeeded');
  assert.equal(parent.children.get(child).reception.status, 'accepted');
});

test('low-level Invocation joins a started child but does not run an unstarted relationship', async () => {
  const childEntered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let started;
  let dormant;
  const parent = new Invocation({
    context: new InvocationContext(null),
    signal: new AbortController().signal,
    work: {
      execute(_context, invocation) {
        started = new Invocation({
          context: new InvocationContext(null),
          signal: new AbortController().signal,
          parent: { invocation },
          work: {
            async execute() {
              childEntered.resolve();
              await finish.promise;
              return 'child';
            },
          },
        });
        dormant = new Invocation({ context: new InvocationContext(null), signal: new AbortController().signal, parent: { invocation }, work: { execute: () => assert.fail('unstarted child must not execute') } });
        void started.run();
        return 'parent';
      },
    },
  });
  let settled = false;
  const pending = parent.run().then((value) => {
    settled = true;
    return value;
  });
  await childEntered.promise;
  assert.equal(settled, false);
  assert.equal(parent.context.status, 'running');
  finish.resolve();
  assert.equal(await pending, 'parent');
  assert.equal(started.context.status, 'succeeded');
  assert.equal(parent.children.get(started).reception.status, 'pending');
  assert.equal(parent.children.get(dormant).returned, undefined);
  assert.equal(parent.context.status, 'succeeded');
});
