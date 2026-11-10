import assert from 'node:assert/strict';
import test from 'node:test';
import { isDistributionFile } from '../../scripts/release/packages.mjs';

test('both distribution batches allow only production artifacts and package metadata', () => {
  for (const path of ['package.json', 'LICENSE', 'README.md', 'dist/index.js', 'dist/index.d.ts', 'dist/resources/operation.js', 'dist/types/contract.d.ts']) assert.equal(isDistributionFile(path), true, path);
  for (const path of ['src/index.ts', 'test/example.test.mjs', 'dist/index.js.map', 'dist/index.d.ts.map', 'dist/index.ts', 'node_modules/dependency/index.js', 'dist/test/index.js', 'dist/tests/index.d.ts', 'dist/nested/__tests__/index.js', 'dist/fixtures/reply.js', 'dist/fixture/input.d.ts', 'dist/benchmarks/size.js', 'dist/benchmark/index.d.ts', 'dist/operation.test.js', 'dist/operation.test.d.ts', 'dist/operation.spec.js', 'dist/fixtures.js', 'dist/nested/test.d.ts', 'dist/../index.js', './dist/index.js', '/dist/index.js', 'dist//index.js', 'dist\\index.js', '', null, undefined]) assert.equal(isDistributionFile(path), false, String(path));
});
