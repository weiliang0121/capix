import assert from 'node:assert/strict';
import { test } from 'node:test';
import { timedTraces } from '../../dist/web/sequence/view.js';

// Minimal trace inputs isolate the timing projection from rendering and model execution.
const trace = (id, occurredAt, offsetMs, durationMs) => ({ id, durationMs, facts: { events: [{ occurredAt, offsetMs }] } });

test('timeline keeps real inter-execution gaps and each execution monotonic offsets', () => {
  const early = trace('early', '2026-09-25T08:00:00.000Z', 12, 1012);
  const later = trace('later', '2026-09-25T08:00:10.000Z', 5, 2005);
  const [a, b] = timedTraces([later, early]);
  assert.equal(a.trace, early);
  assert.equal(b.trace, later);
  assert.equal(a.end - a.start, 1000);
  assert.equal(b.end - b.start, 2000);
  assert.equal(b.start - a.end, 9000);
  // An operation at offset 112 starts 100 ms after the first recorded call.
  assert.equal(a.base + 112 - a.start, 100);
});

test('running traces stop at the last recorded offset without inventing elapsed time', () => {
  const input = trace('running', '2026-09-25T08:00:00.000Z', 3, 3);
  const [item] = timedTraces([input]);
  assert.equal(item.end, item.start);
  assert.deepEqual(timedTraces([]), []);
});

import { layoutTimeline, mapTimelinePosition, qaGap, wheelIntent } from '../../dist/web/sequence/view.js';
const examples = () => timedTraces([trace('one', '2026-09-25T08:00:00.000Z', 10, 1010), trace('two', '2026-09-25T09:00:00.000Z', 4, 2004)]);
const close = (a, b) => assert.ok(Math.abs(a - b) < 0.00001, `${a} != ${b}`);

test('QA layout omits wall-clock waiting, retains duration ratios and fixes gaps at every zoom', () => {
  for (const zoom of [1, 2.3, 64]) {
    const layout = layoutTimeline(examples(), 800, zoom);
    const [a, b] = layout.segments;
    close(b.width / a.width, 2);
    close(b.x - a.x - a.width, qaGap);
    close(b.x + b.width, layout.width);
    close(a.width, 1000 * layout.scale);
    assert.equal(b.start - a.start, 3600000);
  }
});

test('zoom mapping preserves positions within QA and within fixed gaps', () => {
  const before = layoutTimeline(examples(), 800, 1);
  const after = layoutTimeline(examples(), 800, 7);
  const points = [0, before.segments[0].width / 2, before.segments[0].width + 12, before.segments[1].x + before.segments[1].width * 0.75, before.width];
  for (const point of points) close(mapTimelinePosition(mapTimelinePosition(point, before, after), after, before), point);
  const anchor = 200,
    scroll = before.segments[1].x;
  const point = scroll + anchor;
  const nextScroll = mapTimelinePosition(point, before, after) - anchor;
  close(mapTimelinePosition(nextScroll + anchor, after, before), point);
});

test('empty, zero-duration and many-QA layouts keep finite geometry without negative widths', () => {
  assert.equal(layoutTimeline([], 600, 1).width, 600);
  const items = timedTraces(Array.from({ length: 100 }, (_, i) => trace(String(i), '2026-09-25T08:00:00.000Z', 0, i ? 1 : 0)));
  const layout = layoutTimeline(items, 300, 1);
  assert.equal(layout.segments[0].width, 0);
  assert.ok(layout.segments.every((s) => Number.isFinite(s.x) && s.width >= 0));
  assert.ok(layout.width > 300);
});

test('wheel chooses the dominant axis and normalizes line and page deltas', () => {
  assert.deepEqual(wheelIntent(10, 2, 0, 800), { pan: 10, zoom: 0 });
  assert.deepEqual(wheelIntent(2, -10, 0, 800), { pan: 0, zoom: -10 });
  assert.deepEqual(wheelIntent(0, 3, 1, 800), { pan: 0, zoom: 48 });
  assert.deepEqual(wheelIntent(1, 0, 2, 800), { pan: 800, zoom: 0 });
});
