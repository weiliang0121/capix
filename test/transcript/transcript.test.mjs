import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Transcript } from '@weiliang0121/capix-transcript';

test('history accumulates successive turns without changing an earlier message snapshot', () => {
  const history = new Transcript();
  history.append({ role: 'user', content: '天气怎么样？' }, { role: 'assistant', content: '哪个城市？' });
  const previous = history.snapshot();
  history.append({ role: 'user', content: '上海' });
  assert.equal(history.length, 3);
  assert.equal(previous.length, 2);
  assert.deepEqual(history.get(2), { role: 'user', content: '上海' });
  assert.equal(history.get(3), undefined);
  assert.equal(history.get(-1), undefined);
});

test('external edits cannot silently rewrite history content or positions', () => {
  const source = [{ role: 'user', content: 'original' }];
  const history = new Transcript(source);
  source[0].content = 'changed';
  source.length = 0;
  const entry = history.get(0);
  assert.throws(() => {
    entry.content = 'changed again';
  }, TypeError);
  assert.equal(history.get(0), entry);
  const exported = history.snapshot();
  assert.throws(() => {
    exported[0].content = 'changed export';
  }, TypeError);
  exported.reverse();
  exported.push({ role: 'assistant', content: 'extra' });
  assert.deepEqual(history.snapshot(), [{ role: 'user', content: 'original' }]);
});

test('current tracks the latest accepted message of each role, including the first input', () => {
  const transcript = new Transcript();
  assert.equal(transcript.current('user'), undefined);
  assert.equal(transcript.current('assistant'), undefined);
  transcript.append({ role: 'user', content: 'first' });
  assert.equal(transcript.current('user').content, 'first');
  transcript.append({ role: 'assistant', content: 'reply' }, { role: 'user', content: 'next' });
  assert.equal(transcript.current('user').content, 'next');
  assert.equal(transcript.current('assistant').content, 'reply');
  assert.throws(() => {
    transcript.current('user').content = 'external edit';
  }, TypeError);
  assert.equal(transcript.current('user').content, 'next');
});

test('message acceptance is enforced on construction and append without partial writes', () => {
  const invalid = [null, [], 'text', {}, { role: 'system', content: 'x' }, { role: ['user'], content: 'x' }, { role: 'user', content: 1 }, { role: 'assistant', content: ' \n ' }];
  const transcript = new Transcript([{ role: 'user', content: '  original\n' }]);
  const before = transcript.snapshot();
  for (const message of invalid) {
    assert.throws(() => new Transcript([message]), TypeError);
    assert.throws(() => transcript.append({ role: 'assistant', content: 'valid' }, message), TypeError);
    assert.deepEqual(transcript.snapshot(), before);
    assert.equal(transcript.current('assistant'), undefined);
  }
  assert.throws(() => new Transcript({}), TypeError);
  assert.equal(transcript.current('user').content, '  original\n');
});
