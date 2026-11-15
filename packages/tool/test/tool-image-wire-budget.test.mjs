import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32 } from 'node:zlib';
import { ChatCompletionsProvider } from '@weiliang0121/capix-model-provider';
import { assembly, member, host, input, reply, call, final } from './fixture.mjs';

const image = { kind: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC' };

test('portable image projection reserves escaped identities and all attachments before tool effects', async () => {
  const provider = new ChatCompletionsProvider({ endpoint: 'https://fixture.test/chat/completions', apiKey: 'fixture', model: 'fixture', fetch: () => assert.fail('offline inspection must not send') });
  const toolCallId = '\u0001"\\'.repeat(80);
  const content = Array.from({ length: 32 }, () => image);
  const feedbackBytes = Buffer.byteLength(JSON.stringify({ toolCallId, status: 'ok', content }));
  let reserved;
  for (const constrained of [false, true]) {
    let executions = 0;
    let estimate;
    let placeholderBytes;
    let actual;
    const inspection = {
      inspectRequest(request) {
        const measured = provider.inspectRequest(request);
        if (request.exchanges.length) {
          if (request.exchanges[0].feedback[0].content.some((item) => item.kind === 'image')) actual = measured.wireBytes;
          else {
            estimate = measured.wireBytes;
            placeholderBytes = Buffer.byteLength(JSON.stringify(request.exchanges[0].feedback[0]));
          }
        }
        return measured;
      },
    };
    const lookup = member('lookup', () => {
      executions++;
      return { text: 'captured' };
    });
    lookup.result.succeeded = () => ({ status: 'ok', content });
    const model = host((request) => (request.exchanges.length ? final : reply('images', [call(toolCallId, 'lookup', { key: 'preview' })])));
    const fixture = assembly({ policyVersion: 'wire-images.v1', tools: { lookup }, budgets: { maxFeedbackBytes: feedbackBytes, maxWireRequestBytes: constrained ? reserved - 1 : 2 * 1024 * 1024 } }, model, { inspection });
    try {
      if (constrained) {
        await assert.rejects(fixture.runner.run(input), /TOOL_WIRE_REQUEST_LIMIT/);
        assert.equal(executions, 0);
        assert.equal(model.sent.length, 1);
      } else {
        assert.equal(await fixture.runner.run(input), 'finished');
        assert.equal(executions, 1);
        reserved = estimate + 2 * (feedbackBytes - placeholderBytes) + 32 * 128 + 2 * Buffer.byteLength(JSON.stringify(toolCallId)) + 128;
        assert.ok(Number.isSafeInteger(actual) && actual <= reserved);
      }
    } finally {
      await model.interactions.settled();
      model.interactions.close();
    }
  }
});

test('two 256 KiB feedback reservations fit the 2 MiB wire limit with image metadata', async () => {
  // Add a valid ancillary PNG text chunk without changing the 1x1 image pixels.
  const original = Buffer.from(image.data, 'base64');
  const payload = Buffer.from('fixture\0' + 'x'.repeat(180 * 1024));
  const chunk = Buffer.alloc(payload.length + 12);
  chunk.writeUInt32BE(payload.length);
  chunk.write('tEXt', 4);
  payload.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  const large = { ...image, data: Buffer.concat([original.subarray(0, -12), chunk, original.subarray(-12)]).toString('base64') };
  const provider = new ChatCompletionsProvider({ endpoint: 'https://fixture.test/chat/completions', apiKey: 'fixture', model: 'fixture', fetch: () => assert.fail('offline inspection must not send') });
  let executions = 0;
  const lookup = member('lookup', () => {
    executions++;
    return { text: 'captured' };
  });
  lookup.result.succeeded = () => ({ status: 'ok', content: [large] });
  const model = host((request) => (request.exchanges.length ? final : reply('images', [call('first', 'lookup', { key: 'one' }), call('second', 'lookup', { key: 'two' })])));
  const fixture = assembly({ policyVersion: 'wire-images.v1', tools: { lookup }, budgets: { maxFeedbackBytes: 256 * 1024, maxWireRequestBytes: 2 * 1024 * 1024 } }, model, { inspection: provider });
  try {
    assert.equal(await fixture.runner.run(input), 'finished');
    assert.equal(executions, 2);
    assert.equal(model.sent.length, 2);
    assert.ok(provider.inspectRequest(model.sent[1]).wireBytes < 2 * 1024 * 1024);
  } finally {
    await model.interactions.settled();
    model.interactions.close();
  }
});
