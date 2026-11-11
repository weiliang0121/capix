import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageUsage, MessageUsageResource } from '@weiliang0121/capix-measurement';
import { Transcript } from '@weiliang0121/capix-transcript';
import { Resource, Resources } from '@weiliang0121/capix-resources';

test('usage counts exact immutable message identity once per selection and stays instance local', () => {
  const transcript = new Transcript([
    { role: 'user', content: 'same' },
    { role: 'user', content: 'same' },
  ]);
  const first = transcript.get(0);
  const second = transcript.get(1);
  const usage = new MessageUsage();
  usage.add([first, first]);
  assert.equal(usage.get(first), 1);
  assert.equal(usage.get(second), 0);
  usage.add([first, second, second]);
  assert.equal(usage.get(first), 2);
  assert.equal(usage.get(second), 1);
  assert.equal(new MessageUsage().get(first), 0);
  assert.equal(usage.get(Object.freeze({ ...first })), 0);
});

test('measurement resource counts Transcript selections only within its access window', () => {
  const transcript = new Transcript([{ role: 'assistant', content: 'answer' }]);
  const message = transcript.get(0);
  const usage = new MessageUsage();
  const access = new Resources().register(new Resource(usage), MessageUsageResource.record).bind({ record: MessageUsageResource.record.request() }).open();
  access.endpoints.record.add([message, message]);
  assert.equal(usage.get(message), 1);
  access.close();
  assert.throws(() => access.endpoints.record.add([message]));
  assert.equal(usage.get(message), 1);
});
