import test from 'node:test';
import assert from 'node:assert/strict';
import { TextReveal } from '../../apps/observer/.test-dist/presentation/text/reveal.js';

function advance(reveal, from, to, interval = 25) {
  reveal.tick(from);
  for (let now = from + interval; now <= to; now += interval) reveal.tick(now);
}

test('short complete text reveals at a fixed 40 graphemes per second', () => {
  const reveal = new TextReveal({ text: '甲乙丙丁', complete: true });
  assert.deepEqual(reveal.snapshot, { text: '', phase: 'revealing' });
  assert.equal(reveal.tick(0), false);
  assert.equal(reveal.tick(25), true);
  assert.deepEqual(reveal.snapshot, { text: '甲', phase: 'revealing' });
  reveal.tick(50);
  assert.equal(reveal.snapshot.text, '甲乙');
  reveal.tick(75);
  reveal.tick(100);
  assert.deepEqual(reveal.snapshot, { text: '甲乙丙丁', phase: 'finished' });
});

test('complete text selects its final speed once and never slows near the tail', () => {
  const text = '字'.repeat(800);
  const reveal = new TextReveal({ text, complete: true });
  advance(reveal, 0, 1000, 100);
  assert.equal(reveal.snapshot.text.length, 100);
  reveal.receive({ text, complete: true });
  advance(reveal, 1000, 2000, 100);
  assert.equal(reveal.snapshot.text.length, 200);
  advance(reveal, 2000, 7900, 100);
  assert.equal(reveal.snapshot.text.length, 790);
  reveal.tick(8000);
  assert.deepEqual(reveal.snapshot, { text, phase: 'finished' });
});

test('the final speed is capped rather than rushing arbitrarily long text', () => {
  const reveal = new TextReveal({ text: '字'.repeat(2000), complete: true });
  advance(reveal, 0, 1000, 100);
  assert.equal(reveal.snapshot.text.length, 120);
  assert.equal(reveal.snapshot.phase, 'revealing');
});

test('fractional credit yields the same output at different frame rates', () => {
  const fine = new TextReveal({ text: 'x'.repeat(200), complete: false });
  const coarse = new TextReveal({ text: 'x'.repeat(200), complete: false });
  advance(fine, 0, 1000, 10);
  advance(coarse, 0, 1000, 100);
  assert.equal(fine.snapshot.text.length, 40);
  assert.deepEqual(fine.snapshot, coarse.snapshot);
});

test('arrival alone cannot advance visible text or change the open source rate', () => {
  const reveal = new TextReveal({ text: 'x'.repeat(100), complete: false });
  advance(reveal, 0, 500, 100);
  const before = reveal.snapshot;
  reveal.receive({ text: 'x'.repeat(500), complete: false });
  reveal.receive({ text: 'x'.repeat(1000), complete: false });
  assert.equal(reveal.snapshot, before);
  advance(reveal, 500, 1000, 100);
  assert.equal(reveal.snapshot.text.length, 40);
  reveal.receive({ text: 'x'.repeat(1000), complete: true });
  reveal.tick(1100);
  assert.equal(reveal.snapshot.text.length, 52);
});

test('identical available text is consumed independently of packet partitioning', () => {
  const combined = new TextReveal({ text: 'abcdefgh', complete: false });
  const split = new TextReveal({ text: 'ab', complete: false });
  combined.tick(0);
  split.tick(0);
  combined.tick(25);
  split.tick(25);
  split.receive({ text: 'abcd', complete: false });
  split.receive({ text: 'abcdefgh', complete: false });
  advance(combined, 25, 200);
  advance(split, 25, 200);
  assert.deepEqual(split.snapshot, combined.snapshot);
});

test('catching up waits without banking elapsed time for later additions', () => {
  const reveal = new TextReveal({ text: 'a', complete: false });
  advance(reveal, 0, 25);
  assert.deepEqual(reveal.snapshot, { text: 'a', phase: 'waiting' });
  reveal.tick(10000);
  reveal.receive({ text: 'abc', complete: false });
  assert.equal(reveal.snapshot.text, 'a');
  reveal.tick(20000);
  assert.equal(reveal.snapshot.text, 'a');
  reveal.tick(20025);
  assert.equal(reveal.snapshot.text, 'ab');
});

test('pause discards fractional time and a resumed clock does not catch up', () => {
  const reveal = new TextReveal({ text: 'abcdefghij', complete: false });
  reveal.tick(0);
  reveal.tick(20);
  reveal.pause();
  reveal.tick(10000);
  reveal.tick(10005);
  assert.equal(reveal.snapshot.text, '');
  reveal.tick(10025);
  assert.equal(reveal.snapshot.text, 'a');
});

test('a delayed frame cannot reveal more than 100ms of text', () => {
  const reveal = new TextReveal({ text: 'x'.repeat(200), complete: false });
  reveal.tick(0);
  reveal.tick(60000);
  assert.equal(reveal.snapshot.text.length, 4);
  reveal.tick(60025);
  assert.equal(reveal.snapshot.text.length, 5);
});

test('empty open text waits and only explicit completion finishes it', () => {
  const reveal = new TextReveal({ text: '', complete: false });
  const waiting = reveal.snapshot;
  assert.equal(reveal.tick(100), false);
  assert.equal(reveal.snapshot, waiting);
  reveal.receive({ text: '', complete: true });
  assert.deepEqual(reveal.snapshot, { text: '', phase: 'finished' });
  const finished = reveal.snapshot;
  reveal.receive({ text: '', complete: false });
  assert.equal(reveal.snapshot, finished);
  assert.deepEqual(new TextReveal({ text: '', complete: true }).snapshot, finished);
});

test('finish exposes all text and keeps future same-source additions immediate', () => {
  const reveal = new TextReveal({ text: 'abc', complete: false });
  reveal.finish();
  assert.deepEqual(reveal.snapshot, { text: 'abc', phase: 'waiting' });
  reveal.receive({ text: 'abcdef', complete: false });
  assert.deepEqual(reveal.snapshot, { text: 'abcdef', phase: 'waiting' });
  reveal.receive({ text: 'abcdef', complete: true });
  assert.equal(reveal.snapshot.phase, 'finished');
  assert.equal(reveal.tick(1000), false);
});

test('non-prefix replacement degrades to immediate display without replaying edits', () => {
  const reveal = new TextReveal({ text: 'abc', complete: false });
  advance(reveal, 0, 25);
  reveal.receive({ text: 'xyz', complete: false });
  assert.deepEqual(reveal.snapshot, { text: 'xyz', phase: 'waiting' });
  reveal.receive({ text: 'xyz!', complete: false });
  assert.equal(reveal.snapshot.text, 'xyz!');
  reveal.receive({ text: '', complete: true });
  assert.deepEqual(reveal.snapshot, { text: '', phase: 'finished' });
});

test('same-source changes after completion display statically and cannot reopen it', () => {
  const reveal = new TextReveal({ text: 'a', complete: true });
  advance(reveal, 0, 25);
  reveal.receive({ text: 'ab', complete: false });
  assert.deepEqual(reveal.snapshot, { text: 'ab', phase: 'finished' });
  reveal.receive({ text: 'abc', complete: true });
  assert.deepEqual(reveal.snapshot, { text: 'abc', phase: 'finished' });
});

test('Unicode clusters appear whole rather than revealing partial surrogate pairs or joins', () => {
  const clusters = ['👨‍👩‍👧‍👦', 'e\u0301', '🇨🇳', '👍🏽', '字'];
  const reveal = new TextReveal({ text: clusters.join(''), complete: true });
  reveal.tick(0);
  for (let index = 0; index < clusters.length; index += 1) {
    reveal.tick((index + 1) * 25);
    assert.equal(reveal.snapshot.text, clusters.slice(0, index + 1).join(''));
  }
  assert.equal(reveal.snapshot.phase, 'finished');
});

test('an appended combining continuation updates the visible tail without splitting it', () => {
  const reveal = new TextReveal({ text: 'e', complete: false });
  advance(reveal, 0, 25);
  reveal.receive({ text: 'e\u0301🙂', complete: false });
  assert.deepEqual(reveal.snapshot, { text: 'e\u0301', phase: 'revealing' });
  reveal.tick(100);
  reveal.tick(125);
  assert.deepEqual(reveal.snapshot, { text: 'e\u0301🙂', phase: 'waiting' });
});

test('an appended emoji join remains a single consumed grapheme', () => {
  const reveal = new TextReveal({ text: '👨', complete: false });
  advance(reveal, 0, 25);
  reveal.receive({ text: '👨‍👩‍👧‍👦!', complete: true });
  assert.equal(reveal.snapshot.text, '👨‍👩‍👧‍👦');
  reveal.tick(100);
  reveal.tick(125);
  assert.deepEqual(reveal.snapshot, { text: '👨‍👩‍👧‍👦!', phase: 'finished' });
});

test('snapshot identity changes only when visible text or presentation phase changes', () => {
  const reveal = new TextReveal({ text: 'abc', complete: false });
  const initial = reveal.snapshot;
  assert.equal(Object.isFrozen(initial), true);
  reveal.tick(0);
  assert.equal(reveal.tick(10), false);
  assert.equal(reveal.snapshot, initial);
  reveal.receive({ text: 'abcd', complete: false });
  assert.equal(reveal.snapshot, initial);
  assert.equal(reveal.tick(25), true);
  assert.notEqual(reveal.snapshot, initial);
});

test('instances have independent rates, clocks and skip preferences', () => {
  const first = new TextReveal({ text: 'abc', complete: true });
  const second = new TextReveal({ text: 'xyz', complete: true });
  first.finish();
  assert.deepEqual(second.snapshot, { text: '', phase: 'revealing' });
  advance(second, 0, 25);
  assert.equal(second.snapshot.text, 'x');
  assert.equal(first.snapshot.text, 'abc');
});

test('incremental segmentation preserves graphemes across every UTF-16 packet boundary', () => {
  for (const text of ['🇨🇳🇬🇧🇺🇸🇯🇵!', 'a\r\nb', 'e\u0301\u0308🙂', '👨‍👩‍👧‍👦👍🏽!', '\u0600字क्‍ष']) {
    const incremental = new TextReveal({ text: '', complete: false });
    for (let end = 1; end <= text.length; end++) incremental.receive({ text: text.slice(0, end), complete: false });
    incremental.receive({ text, complete: true });
    const complete = new TextReveal({ text, complete: true });
    for (let now = 0; now <= 1000; now += 25) {
      incremental.tick(now);
      complete.tick(now);
      assert.deepEqual(incremental.snapshot, complete.snapshot, JSON.stringify(text));
    }
  }
});

test('segmentation work grows with appended text instead of all prior prefixes', (t) => {
  const segment = Intl.Segmenter.prototype.segment;
  let units = 0;
  t.mock.method(Intl.Segmenter.prototype, 'segment', function (text) {
    units += text.length;
    return segment.call(this, text);
  });
  const reveal = new TextReveal({ text: '', complete: false });
  let text = '';
  for (let index = 0; index < 1000; index++) {
    text += '字🙂abcdef';
    reveal.receive({ text, complete: false });
  }
  assert.ok(units <= text.length + 1000, `segmented ${units} units for ${text.length} received units`);
  reveal.finish();
  const before = units;
  reveal.receive({ text: `${text}extra`, complete: true });
  assert.equal(units, before, 'static display has no remaining grapheme work');
  assert.equal(reveal.snapshot.text, `${text}extra`);
});
