import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnswerTextDecoder, answerOutputContract, answerStream } from '@capix/observer-service/conversation';

function decode(chunks) {
  const decoder = new AnswerTextDecoder();
  return chunks.map((chunk) => decoder.push(chunk)).join('');
}

test('answer decoder accepts either field order at every two-part split and one-code-unit chunks', () => {
  const content = '第一行\n第二行 "quoted" \\ slash / emoji 😀\b\f\r\t\u0001';
  const forms = [JSON.stringify({ kind: 'answer', content }), JSON.stringify({ content, kind: 'needs-info' }, null, 2)];
  for (const raw of forms) {
    for (let split = 0; split <= raw.length; split += 1) assert.equal(decode([raw.slice(0, split), raw.slice(split)]), content, `split ${split}`);
    assert.equal(decode(raw.split('')), content);
  }
});

test('escaped field names, unicode pairs and slash escapes decode without exposing JSON syntax', () => {
  const raw = '{"\\u0063ontent":"\\u4f60\\u597d\\ud83d\\ude00\\/tail","kind":"unknown"}';
  assert.equal(decode(raw.split('')), '你好😀/tail');
  assert.deepEqual(answerOutputContract.accept(JSON.parse(raw)), { content: '你好😀/tail', kind: 'unknown' });
});

test('decoder withholds incomplete escape and surrogate fragments until the next chunk', () => {
  const decoder = new AnswerTextDecoder();
  assert.equal(decoder.push('{"content":"before\\uD83'), 'before');
  assert.equal(decoder.push('D'), '');
  assert.equal(decoder.push('\\uDE'), '');
  assert.equal(decoder.push('00after\\'), '😀after');
  assert.equal(decoder.push('n","kind":"answer"}'), '\n');
});

test('preview parsing errors stop that decoder without admitting or throwing a business result', () => {
  const raw = '{"content":"prefix\\qbroken","kind":"answer"}';
  const decoder = new AnswerTextDecoder();
  assert.equal(decoder.push(raw), 'prefix');
  assert.equal(decoder.push('{"content":"must not restart","kind":"answer"}'), '');
  assert.throws(() => JSON.parse(raw));
});

test('preview availability never stands in for final JSON or schema acceptance', () => {
  const missingKind = '{"content":"visible before acceptance"}';
  assert.equal(decode(missingKind.split('')), 'visible before acceptance');
  assert.throws(() => answerOutputContract.accept(JSON.parse(missingKind)), { code: 'OUTPUT_SHAPE' });
  const unfinished = '{"content":"visible but unfinished';
  assert.equal(decode(unfinished.split('')), 'visible but unfinished');
  assert.throws(() => JSON.parse(unfinished));
});

test('duplicate or unexpected fields stop provisional interpretation while final acceptance remains independent', () => {
  const duplicate = '{"content":"first","content":"second","kind":"answer"}';
  assert.equal(decode(duplicate.split('')), 'first');
  assert.equal(answerOutputContract.accept(JSON.parse(duplicate)).content, 'second');
  const extra = '{"content":"visible","other":"hidden","kind":"answer"}';
  assert.equal(decode(extra.split('')), 'visible');
  assert.throws(() => answerOutputContract.accept(JSON.parse(extra)), { code: 'OUTPUT_SHAPE' });
});

test('unpaired surrogates invalidate the preview and do not leak an incomplete code point', () => {
  for (const raw of ['{"content":"a\\ud83db","kind":"answer"}', '{"content":"a\\ude00b","kind":"answer"}']) assert.equal(decode(raw.split('')), 'a');
});

test('answer output declaration checks final shape without replacing the accepted result identity', () => {
  const answer = { kind: 'answer', content: 'final' };
  assert.equal(answerStream.result(answer), answer);
  assert.throws(() => answerStream.result({ kind: 'answer', content: '' }), { code: 'OUTPUT_SHAPE' });
  assert.throws(() => answerStream.delta({ text: '' }));
});
