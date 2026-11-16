import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatCompletionsProvider, requireModelRequest, requireToolResult, requireModelExchange } from '@weiliang0121/capix-model-provider';

const png = { kind: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC' };
const text = (text) => ({ kind: 'text', text });
const raw = { id: 'reply', model: 'fixture', choices: [{ message: { role: 'assistant', content: 'Seen.' }, finish_reason: 'stop' }], usage: null };
const provider = (fetch) => new ChatCompletionsProvider({ endpoint: 'https://fixture.test/chat/completions', apiKey: 'fixture', model: 'fixture', fetch });
const reply = { formatVersion: 1, id: 'reply', model: 'fixture', output: [{ kind: 'tool-call', id: 'call', name: 'capture', arguments: { encoding: 'json-text', text: '{}' } }], termination: { kind: 'completed', reason: 'tool_calls' }, usage: null, native: { format: 'chat-completions', version: 1 } };
const wireImage = { type: 'image_url', image_url: { url: `data:${png.mimeType};base64,${png.data}` } };

test('fixed image messages and tool feedback encode in order with exact request inspection', async () => {
  const content = [text('before'), png, text('after'), png];
  const exchange = { reply, feedback: [{ toolCallId: 'call', status: 'error', content }] };
  assert.equal(requireModelExchange(exchange), exchange);
  const request = {
    messages: [
      { role: 'user', content },
      { role: 'assistant', content: [text('prior')] },
    ],
    exchanges: [exchange],
  };
  let sent;
  const model = provider(async (_url, init) => {
    sent = init.body;
    return Response.json(raw);
  });
  const inspection = model.inspectRequest(request);
  await model.complete(request);
  const body = JSON.parse(sent);
  const expected = [{ type: 'text', text: 'before' }, wireImage, { type: 'text', text: 'after' }, wireImage];
  assert.deepEqual(body.messages[0], { role: 'user', content: expected });
  assert.deepEqual(body.messages[1], { role: 'assistant', content: [{ type: 'text', text: 'prior' }] });
  assert.deepEqual(body.messages[3], { role: 'tool', tool_call_id: 'call', content: JSON.stringify({ status: 'error', content: [text('before'), { kind: 'image-reference', contentIndex: 1 }, text('after'), { kind: 'image-reference', contentIndex: 3 }] }) });
  assert.deepEqual(body.messages[4], { role: 'user', content: [{ type: 'text', text: JSON.stringify({ kind: 'tool-images', toolCallId: 'call' }) }, { type: 'text', text: JSON.stringify({ contentIndex: 1 }) }, wireImage, { type: 'text', text: JSON.stringify({ contentIndex: 3 }) }, wireImage] });
  assert.equal(exchange.feedback[0].content[1], png);
  assert.equal(inspection.requestBytes, Buffer.byteLength(JSON.stringify(request)));
  assert.equal(inspection.wireBytes, Buffer.byteLength(sent));
});

test('pure text message and tool wire shape remain unchanged', async () => {
  const result = { status: 'ok', content: [text('a'), text('b')] };
  await provider(async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.messages[0], { role: 'user', content: 'question' });
    assert.equal(body.messages[2].content, JSON.stringify(result));
    return Response.json(raw);
  }).complete({ messages: [{ role: 'user', content: 'question' }], exchanges: [{ reply, feedback: [{ toolCallId: 'call', ...result }] }] });
});

test('malformed, mutable or mismatched image material rejects before transport without exposing bytes', async () => {
  let sends = 0;
  let getters = 0;
  const model = provider(async () => {
    sends++;
    return Response.json(raw);
  });
  const accessor = {
    kind: 'image',
    mimeType: 'image/png',
    get data() {
      getters++;
      return png.data;
    },
  };
  const images = [{ ...png, data: '' }, { ...png, data: png.data + '\n' }, { ...png, data: png.data + '=' }, { ...png, data: 'Zh==' }, { ...png, data: 'data:image/png;base64,' + png.data }, { ...png, mimeType: 'image/jpeg' }, { ...png, mimeType: 'image/svg+xml' }, { kind: 'image', mimeType: 'image/png', url: 'https://fixture.test/private.png' }, { kind: 'image', mimeType: 'image/png', path: '/private/image.png' }, { ...png, data: Buffer.from('private-image-body').toString('base64') }, { ...png, data: Buffer.from(png.data, 'base64').subarray(0, -1).toString('base64') }, accessor];
  for (const image of images) {
    assert.throws(() => requireToolResult({ status: 'ok', content: [image] }), TypeError);
    const request = { messages: [{ role: 'user', content: [image] }] };
    assert.throws(
      () => model.inspectRequest(request),
      (error) => error.code === 'REQUEST' && !String(error).includes(png.data),
    );
    await assert.rejects(model.complete(request), (error) => error.code === 'REQUEST' && !String(error).includes('private-image-body'));
  }
  for (const role of ['system', 'assistant']) await assert.rejects(model.complete({ messages: [{ role, content: [png] }] }), (error) => error.code === 'REQUEST');
  assert.equal(sends, 0);
  assert.equal(getters, 0);
});

test('image bytes count against common and wire budgets and are revalidated after inspection', async () => {
  let sends = 0;
  const model = provider(async () => {
    sends++;
    return Response.json(raw);
  });
  const request = { messages: [{ role: 'user', content: [{ ...png }] }] };
  assert.equal(requireModelRequest(request), request);
  model.inspectRequest(request);
  request.messages[0].content[0].data = 'A'.repeat(2 * 1024 * 1024);
  await assert.rejects(model.complete(request), (error) => error.code === 'REQUEST');
  // Exactly at the common limit, but the data URL and fixed configuration push wire bytes over it.
  const bounded = { messages: [{ role: 'user', content: [png, text('')] }] };
  const overhead = Buffer.byteLength(JSON.stringify(bounded));
  bounded.messages[0].content[1].text = 'x'.repeat(2 * 1024 * 1024 - overhead);
  assert.equal(requireModelRequest(bounded), bounded);
  await assert.rejects(model.complete(bounded), (error) => error.code === 'REQUEST_LIMIT' && error.metric === 'wireBytes');
  assert.equal(sends, 0);
});

// Offline encodings of a synthetic 1x1 white PPM, produced with sips and cwebp.
const otherImages = [
  {
    kind: 'image',
    mimeType: 'image/jpeg',
    data: '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAaADAAQAAAABAAAAAQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAQABAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A/fyiiigD/9k=',
  },
  { kind: 'image', mimeType: 'image/webp', data: 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAgA0JaQAA3AA/vuUAAA=' },
];
test('JPEG and WebP signatures retain declared bytes and reject MIME mismatches', async () => {
  for (const image of otherImages) {
    const result = { status: 'ok', content: [image] };
    assert.equal(requireToolResult(result), result);
    assert.throws(() => requireToolResult({ status: 'ok', content: [{ ...image, mimeType: 'image/png' }] }), TypeError);
    await provider(async (_url, init) => {
      assert.deepEqual(JSON.parse(init.body).messages[0].content, [{ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } }]);
      return Response.json(raw);
    }).complete({ messages: [{ role: 'user', content: [image] }] });
  }
});

test('all tool slots close before image attachments, in call order despite reversed feedback', async () => {
  const second = { ...reply.output[0], id: 'second' };
  const multiple = { ...reply, output: [...reply.output, second] };
  const exchange = {
    reply: multiple,
    feedback: [
      { toolCallId: 'second', status: 'ok', content: [png, text('after second')] },
      { toolCallId: 'call', status: 'ok', content: [text('before first'), png] },
    ],
  };
  await provider(async (_url, init) => {
    const messages = JSON.parse(init.body).messages;
    assert.deepEqual(
      messages.map((item) => item.role),
      ['user', 'assistant', 'tool', 'tool', 'user'],
    );
    assert.deepEqual(
      messages.slice(2, 4).map((item) => item.tool_call_id),
      ['call', 'second'],
    );
    assert.ok(messages.slice(2, 4).every((item) => typeof item.content === 'string' && !item.content.includes(png.data)));
    assert.deepEqual(messages[4].content, [{ type: 'text', text: JSON.stringify({ kind: 'tool-images', toolCallId: 'call' }) }, { type: 'text', text: JSON.stringify({ contentIndex: 1 }) }, wireImage, { type: 'text', text: JSON.stringify({ kind: 'tool-images', toolCallId: 'second' }) }, { type: 'text', text: JSON.stringify({ contentIndex: 0 }) }, wireImage]);
    return Response.json(raw);
  }).complete({ messages: [{ role: 'user', content: 'Inspect' }], exchanges: [exchange] });
});

test('expanded tool attachments enforce the exact wire limit before sending', async () => {
  let sends = 0;
  const model = provider(async () => {
    sends++;
    return Response.json(raw);
  });
  const request = { messages: [{ role: 'user', content: 'Inspect' }], exchanges: [{ reply, feedback: [{ toolCallId: 'call', status: 'ok', content: [png, text('')] }] }] };
  const overhead = model.inspectRequest(request).wireBytes;
  request.exchanges[0].feedback[0].content[1].text = 'x'.repeat(2 * 1024 * 1024 - overhead);
  assert.equal(model.inspectRequest(request).wireBytes, 2 * 1024 * 1024);
  await model.complete(request);
  request.exchanges[0].feedback[0].content[1].text += 'x';
  assert.equal(requireModelRequest(request), request);
  assert.equal(model.inspectRequest(request).wireBytes, 2 * 1024 * 1024 + 1);
  await assert.rejects(model.complete(request), (error) => error.code === 'REQUEST_LIMIT' && error.metric === 'wireBytes');
  assert.equal(sends, 1);
});

test('raised request budgets admit large fixed images without expanding feedback or block limits', async () => {
  // Signature-only synthetic JPEG: pixel decodability is deliberately outside this contract.
  const bytes = Buffer.alloc(2 * 1024 * 1024);
  bytes.set([255, 216, 255]);
  bytes.set([255, 217], bytes.length - 2);
  const image = { kind: 'image', mimeType: 'image/jpeg', data: bytes.toString('base64') };
  const request = { messages: [{ role: 'user', content: [image] }] };
  let sent;
  let sends = 0;
  const model = new ChatCompletionsProvider({
    endpoint: 'https://fixture.test/chat/completions',
    apiKey: 'fixture',
    model: 'fixture',
    maxRequestBytes: 4 * 1024 * 1024,
    maxWireRequestBytes: 4 * 1024 * 1024,
    fetch: async (_url, init) => {
      sends++;
      sent = init.body;
      return Response.json(raw);
    },
  });
  const inspection = model.inspectRequest(request);
  assert.ok(inspection.requestBytes > 2 * 1024 * 1024);
  await model.complete(request);
  assert.equal(inspection.wireBytes, Buffer.byteLength(sent));
  assert.equal(inspection.requestBytes, Buffer.byteLength(JSON.stringify(request)));
  assert.throws(() => requireToolResult({ status: 'ok', content: [image] }), /byte limit/);
  const tooMany = { messages: [{ role: 'user', content: Array.from({ length: 33 }, () => png) }] };
  assert.throws(
    () => model.inspectRequest(tooMany),
    (error) => error.code === 'REQUEST',
  );
  await assert.rejects(model.complete(tooMany), (error) => error.code === 'REQUEST');
  assert.equal(sends, 1);
});
