import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runFeatureMatrix } from './feature-matrix.mjs';

test('Node completes the public platform feature matrix', async (t) => {
  const rows = await runFeatureMatrix();
  assert.ok(rows.length > 0);
  for (const row of rows) {
    await t.test(row.feature, () => assert.equal(row.status, 'passed', row.stack ?? row.error));
  }
});
