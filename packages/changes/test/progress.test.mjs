import assert from 'node:assert/strict';

import { test } from 'node:test';

import { ProgressChannel } from '@weiliang0121/capix-changes';

const message = (content) => ({ role: 'user', content });

test('unexpected asynchronous receive/report results are isolated without unhandled rejections', async () => {
  let notifications = 0;
  const channel = new ProgressChannel({
    async receive() {
      notifications++;
      throw new Error('late receive failure');
    },
    async failed() {
      throw new Error('late report failure');
    },
  });
  channel.publish(Object.freeze({ done: true }));
  channel.publish(Object.freeze({ done: true }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notifications, 1);
  assert.match(channel.failure.error.message, /synchronously/);
});

test('a throwing failure reporter getter and thrown undefined cannot escape or reactivate a channel', () => {
  let notifications = 0;
  const channel = new ProgressChannel({
    receive() {
      notifications++;
      throw undefined;
    },
    get failed() {
      throw new Error('failed getter');
    },
  });
  channel.publish({});
  channel.publish({});
  assert.deepEqual(channel.failure, { error: undefined });
  assert.equal(notifications, 1);
});
