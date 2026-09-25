import assert from 'node:assert/strict';
import { test } from 'node:test';
import { columnGap, densityScroll, layoutColumns, layoutInvocations, maximumColumnWidth, minimumColumnWidth, visibleColumns, wheelIntent } from '../../apps/observer/.test-dist/features/explorer/layout.js';

const call = (id, recordType, offsetMs, durationMs, parentId, name = id) => ({ id, recordType, offsetMs, durationMs, parentId, name, label: id, status: durationMs === undefined ? 'running' : 'succeeded' });
const execution = (calls, observedOffsetMs = 0) => ({ calls, observedOffsetMs });
const close = (a, b) => assert.ok(Math.abs(a - b) < 0.00001, `${a} != ${b}`);

test('QA columns retain equal readable widths independently of duration or count', () => {
  const layout = layoutColumns(['short', 'long'], 440);
  assert.equal(layout.columns[0].width, layout.columns[1].width);
  assert.equal(layout.columns[1].x - layout.columns[0].width, columnGap);
  assert.equal(layoutColumns([], 440).width, 0);
  const many = layoutColumns(
    Array.from({ length: 120 }, (_, index) => String(index)),
    5,
  );
  assert.equal(many.columnWidth, minimumColumnWidth);
  assert.ok(many.width > 38000);
  assert.equal(layoutColumns(['one'], Infinity).columnWidth, 440);
  assert.equal(layoutColumns(['one'], 2000).columnWidth, maximumColumnWidth);
});

test('only calls within the same execution share a time scale, with nested lanes and inherited families', () => {
  const calls = [call('e', 'execution', 10, 1000), call('selection', 'operation', 110, 600, 'e'), call('inner', 'operation', 210, 300, 'selection'), call('model', 'attempt', 250, 100, 'inner')];
  const layout = layoutInvocations(execution(calls));
  const [e, operation, nested, attempt] = layout.calls;
  close(e.width, 1);
  close(operation.left, 0.1);
  close(operation.width, 0.6);
  assert.equal(operation.lane, 0);
  assert.equal(nested.lane, 1);
  assert.equal(attempt.lane, 1);
  assert.equal(attempt.family, 'selection');
  assert.equal(layout.operationLanes, 2);
  assert.equal(layout.attemptLanes, 2);
  assert.ok(attempt.left >= nested.left && attempt.left + attempt.width <= nested.left + nested.width);
  const faster = layoutInvocations(execution(calls.map((item) => ({ ...item, offsetMs: item.offsetMs / 10, durationMs: item.durationMs / 10 }))));
  close(faster.calls[1].width, operation.width);
});

test('running geometry ends at observed offsets and never invents a completed duration', () => {
  const layout = layoutInvocations(execution([call('e', 'execution', 5), call('memory', 'operation', 10, undefined, 'e')], 30));
  assert.equal(layout.calls[0].call.durationMs, undefined);
  close(layout.calls[0].width, 1);
  close(layout.calls[1].left, 0.2);
  close(layout.calls[1].width, 0.8);
  const zero = layoutInvocations(execution([call('e', 'execution', 5, 0)], 5));
  assert.equal(zero.calls[0].width, 0);
  assert.ok(Number.isFinite(zero.calls[0].left));
});

test('density changes keep pointer position inside a QA or gap and clamp viewport edges', () => {
  const before = layoutColumns(['a', 'b', 'c', 'd'], 440);
  const after = layoutColumns(['a', 'b', 'c', 'd'], 700);
  const anchor = 120;
  const scroll = before.columns[1].x + before.columnWidth * 0.25 - anchor;
  const nextScroll = densityScroll(before, after, scroll, anchor, 600);
  close(nextScroll + anchor, after.columns[1].x + after.columnWidth * 0.25);
  const gapPosition = before.columnWidth + 10;
  close(densityScroll(before, after, gapPosition - anchor, anchor, 600) + anchor, after.columnWidth + 10);
  assert.equal(densityScroll(before, after, 0, 0, 600), 0);
  assert.equal(densityScroll(before, after, 99999, 0, 600), after.width - 600);
  assert.equal(densityScroll(layoutColumns(['a'], 440), layoutColumns(['a'], 320), 0, 300, 800), 0);
});

test('visible range excludes QA that only touch a viewport boundary', () => {
  const layout = layoutColumns(['a', 'b', 'c'], 440);
  assert.deepEqual(visibleColumns(layout, 0, 440), ['a']);
  assert.deepEqual(visibleColumns(layout, 440, 480), ['b']);
  assert.deepEqual(visibleColumns(layout, 100, 800), ['a', 'b']);
});

test('wheel separates horizontal panning from density and supports line/page and shift input', () => {
  assert.deepEqual(wheelIntent(10, 2, 0, 800), { pan: 10, density: 0 });
  assert.deepEqual(wheelIntent(2, -10, 0, 800), { pan: 0, density: -10 });
  assert.deepEqual(wheelIntent(0, 3, 1, 800), { pan: 0, density: 48 });
  assert.deepEqual(wheelIntent(1, 0, 2, 800), { pan: 800, density: 0 });
  assert.deepEqual(wheelIntent(0, 40, 0, 800, true), { pan: 40, density: 0 });
});
