import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layoutColumns, visibleColumnWindow } from '../../apps/observer/.test-dist/features/explorer/layout.js';

test('QA viewport mounts neighboring columns while navigation highlights only intersecting columns', () => {
  const layout = layoutColumns(['a', 'b', 'c', 'd', 'e'], 440);
  const window = visibleColumnWindow(layout, 920, 440);
  assert.deepEqual(window.visibleIds, ['c']);
  assert.deepEqual(
    window.columns.map(({ id, index }) => ({ id, index })),
    [
      { id: 'b', index: 1 },
      { id: 'c', index: 2 },
      { id: 'd', index: 3 },
    ],
  );
  assert.equal(window.columns[1].x, layout.columns[2].x);
  assert.equal(window.columns[1].width, layout.columnWidth);
  assert.deepEqual(
    visibleColumnWindow(layout, 920, 440, 0).columns.map(({ id }) => id),
    ['c'],
  );
});

test('QA viewport excludes touching boundaries and retains neighbors when viewing only a gap', () => {
  const layout = layoutColumns(['a', 'b', 'c'], 440);
  assert.deepEqual(visibleColumnWindow(layout, 440, 480, 0).visibleIds, ['b']);
  const gap = visibleColumnWindow(layout, 440, 20);
  assert.deepEqual(gap.visibleIds, []);
  assert.deepEqual(
    gap.columns.map(({ id }) => id),
    ['a', 'b'],
  );
  assert.deepEqual(visibleColumnWindow(layout, 440, 20, 0).columns, []);
  assert.deepEqual(visibleColumnWindow(layout, 459.5, 1, 0).visibleIds, ['b']);
});

test('QA viewport bounds overscan and tolerates empty, hidden, and invalid viewports', () => {
  const layout = layoutColumns(['a', 'b', 'c'], 440);
  assert.deepEqual(visibleColumnWindow(layoutColumns([], 440), 0, 1000), { columns: [], visibleIds: [] });
  for (const width of [0, -1, NaN, Infinity]) assert.deepEqual(visibleColumnWindow(layout, 0, width), { columns: [], visibleIds: [] });
  for (const left of [NaN, Infinity, layout.width, layout.width + 10]) assert.deepEqual(visibleColumnWindow(layout, left, 440), { columns: [], visibleIds: [] });
  assert.deepEqual(visibleColumnWindow(layout, -20, 440).visibleIds, ['a']);
  assert.deepEqual(
    visibleColumnWindow(layout, 0, 2000).columns.map(({ index }) => index),
    [0, 1, 2],
  );
  assert.deepEqual(
    visibleColumnWindow(layout, 920, 440, 100).columns.map(({ index }) => index),
    [0, 1, 2],
  );
  for (const overscan of [-1, NaN, Infinity])
    assert.deepEqual(
      visibleColumnWindow(layout, 460, 440, overscan).columns.map(({ index }) => index),
      [1],
    );
});

test('QA viewport keeps the rendered window bounded as the conversation grows', () => {
  const layout = layoutColumns(
    Array.from({ length: 10000 }, (_, index) => String(index)),
    440,
  );
  const window = visibleColumnWindow(layout, layout.columns[5000].x + 100, 1000);
  assert.deepEqual(window.visibleIds, ['5000', '5001', '5002']);
  assert.deepEqual(
    window.columns.map(({ index }) => index),
    [4999, 5000, 5001, 5002, 5003],
  );
});
