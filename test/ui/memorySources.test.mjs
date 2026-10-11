import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { MemoryResultSources } from '../../apps/observer/.test-dist/features/memory/MemoryResultSources.js';

const requireApp = createRequire(new URL('../../apps/observer/package.json', import.meta.url));
const { createElement } = requireApp('react');
const { renderToStaticMarkup } = requireApp('react-dom/server');
const source = { id: 'saved-result', kind: 'file-created', answerIndex: 5, receipt: { path: 'summary.md', bytes: 12, digest: 'a'.repeat(64) } };

test('memory result source renders the actual receipt and its historical meaning separately from original messages', () => {
  const html = renderToStaticMarkup(createElement(MemoryResultSources, { sources: [source], label: '本次操作依据' }));
  assert.match(html, /本次操作依据/);
  assert.match(html, /summary.md/);
  assert.match(html, /12 字节/);
  assert.match(html, /关联回答 \[5\]/);
  assert.match(html, new RegExp(source.receipt.digest));
  assert.match(html, /不保证文件现在仍存在或内容未变/);
  assert.equal(renderToStaticMarkup(createElement(MemoryResultSources, {})), '');
  assert.equal(renderToStaticMarkup(createElement(MemoryResultSources, { sources: [] })), '');
});
