import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatCompletionsProvider, ProviderRequestLimitError, requireModelRequest } from '@weiliang0121/capix-model-provider';
import { ModelExchanges, requireModelImageContext } from '@weiliang0121/capix-model-exchanges';

const image = { kind: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC' };
const text = { kind: 'text', text: 'original tool text' };
const basis = (retain) => ({ request: { messages: [{ role: 'user', content: [image, { kind: 'text', text: 'reference' }] }] }, catalog: { tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }], digest: 'catalog', policyVersion: 'v1', ...(retain === undefined ? {} : { imageContext: { retainLatestToolImages: retain } }) } });
const reply = (ids) => ({ formatVersion: 1, id: 'reply', model: 'offline', output: ids.map((id) => ({ kind: 'tool-call', id, name: 'read', arguments: { encoding: 'json-text', text: '{}' } })), termination: { kind: 'completed', reason: 'tool_calls' }, usage: null, native: { format: 'chat-completions', version: 1 } });
function append(entity, origin, id, ids = [id]) {
  let reference = entity.intake(origin, { parentContextId: 'parent', childContextId: id, position: 'model' }, reply(ids));
  // Reverse acceptance order proves the window uses protocol call order.
  for (const callId of [...ids].reverse()) reference = entity.complete(origin, reference, callId, { status: 'ok', content: [text, image, image] });
  return reference;
}

test('fixed tool image window preserves reference images, call closure and immutable originals', () => {
  for (const retain of [0, 1, 3, 20, undefined]) {
    const entity = new ModelExchanges();
    const origin = entity.begin('origin', basis(retain));
    const first = append(entity, origin, 'one', ['a', 'b']);
    const second = append(entity, origin, 'two');
    const snapshot = structuredClone(entity.snapshot());
    const request = entity.request({ origin, exchanges: [first, second] });
    const parts = request.exchanges.flatMap((entry) => entry.feedback.flatMap((feedback) => feedback.content));
    assert.deepEqual(request.messages, basis(retain).request.messages);
    assert.equal(parts.filter((part) => part.kind === 'image').length, retain === undefined ? 6 : Math.min(retain, 6));
    assert.equal(parts.filter((part) => part.text === text.text).length, 3);
    if (retain === 3) {
      assert.deepEqual(
        request.exchanges[0].feedback.map((feedback) => feedback.toolCallId),
        ['a', 'b'],
      );
      assert.equal(request.exchanges[0].feedback[0].content[1].kind, 'text');
      assert.match(request.exchanges[0].feedback[0].content[1].text, /contentIndex=1/);
      assert.equal(request.exchanges[0].feedback[1].content[1].kind, 'text');
      assert.equal(request.exchanges[0].feedback[1].content[2].kind, 'image');
    }
    assert.deepEqual(entity.snapshot(), snapshot);
    assert.equal(entity.read(origin, first).feedback[0].content[1].kind, 'image');
    const restored = ModelExchanges.restore(structuredClone(snapshot));
    assert.deepEqual(restored.request({ origin, exchanges: [first, second] }), request);
    // An earlier prefix projects using only its own images.
    assert.equal(
      restored
        .request({ origin, exchanges: [first] })
        .exchanges.flatMap((entry) => entry.feedback.flatMap((feedback) => feedback.content))
        .filter((part) => part.kind === 'image').length,
      retain === undefined ? 4 : Math.min(retain, 4),
    );
  }
});

test('image policy is fixed origin data; invalid policies and changed recovery basis reject without writes', () => {
  const entity = new ModelExchanges();
  const value = basis(1);
  const origin = entity.begin('origin', value);
  value.catalog.imageContext.retainLatestToolImages = 9;
  assert.equal(entity.origin(origin).catalog.imageContext.retainLatestToolImages, 1);
  const saved = entity.snapshot();
  assert.throws(() => entity.begin('origin', basis(2)));
  assert.throws(() => entity.begin('origin', basis(undefined)));
  const forged = structuredClone(saved);
  forged.origins[0].catalog.imageContext.retainLatestToolImages = 2;
  assert.throws(() => ModelExchanges.restore(forged));
  let evaluated = 0;
  for (const policy of [
    {},
    { retainLatestToolImages: -1 },
    { retainLatestToolImages: -0 },
    { retainLatestToolImages: 1.5 },
    { retainLatestToolImages: Infinity },
    { retainLatestToolImages: 1, extra: true },
    {
      get retainLatestToolImages() {
        evaluated++;
        return 1;
      },
    },
  ])
    assert.throws(() => requireModelImageContext(policy));
  assert.equal(evaluated, 0);
  assert.deepEqual(entity.snapshot(), saved);
});

test('historical image projection reduces a valid large request to the default provider sending budget', async () => {
  // A valid PNG ancillary text chunk makes the fixture large without decoding pixels.
  const png = Buffer.from(image.data, 'base64');
  const data = Buffer.from('fixture\0' + 'x'.repeat(450 * 1024));
  const type = Buffer.from('tEXt');
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([type, data])) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  const largeImage = { ...image, data: Buffer.concat([png.subarray(0, -12), length, type, data, checksum, png.subarray(-12)]).toString('base64') };
  const entity = new ModelExchanges();
  const origin = entity.begin('origin', basis(1));
  const references = [];
  for (let index = 0; index < 5; index++) {
    const id = `call${index}`;
    const ref = entity.intake(origin, { parentContextId: 'parent', childContextId: id, position: 'model' }, reply([id]));
    references.push(entity.complete(origin, ref, id, { status: 'ok', content: [largeImage] }));
  }
  const raw = entity.closed(origin, references).map(({ reply, feedback }) => ({ reply, feedback }));
  const full = requireModelRequest({ ...basis(1).request, tools: basis(1).catalog.tools, exchanges: raw });
  assert.ok(Buffer.byteLength(JSON.stringify(full)) > 2 * 1024 * 1024);
  let sends = 0;
  const provider = new ChatCompletionsProvider({
    endpoint: 'https://offline.fixture.test/chat/completions',
    apiKey: 'offline',
    model: 'offline',
    fetch: async () => {
      sends++;
      return Response.json({ id: 'final', model: 'offline', choices: [{ index: 0, message: { role: 'assistant', content: 'finished' }, finish_reason: 'stop' }], usage: null });
    },
  });
  await assert.rejects(provider.complete(full), ProviderRequestLimitError);
  assert.equal(sends, 0);
  const actual = entity.request({ origin, exchanges: references });
  assert.equal(actual.exchanges.flatMap((entry) => entry.feedback.flatMap((item) => item.content)).filter((part) => part.kind === 'image').length, 1);
  assert.deepEqual(ModelExchanges.restore(structuredClone(entity.snapshot())).request({ origin, exchanges: references }), actual);
  await provider.complete(actual);
  assert.equal(sends, 1);
});
