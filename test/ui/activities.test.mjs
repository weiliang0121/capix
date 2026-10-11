import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ConversationProcess } from '../../apps/observer/.test-dist/features/conversation/ConversationProcess.js';

const requireApp = createRequire(new URL('../../apps/observer/package.json', import.meta.url));
const { createElement } = requireApp('react');
const { renderToStaticMarkup } = requireApp('react-dom/server');
const process = { id: 'submission-1', label: '正在生成回答 · 调用模型', active: true, inputPending: false };

test('current progress is one accessible live hint instead of a call history or disclosure', () => {
  const html = renderToStaticMarkup(createElement(ConversationProcess, { process }));
  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /正在生成回答 · 调用模型/);
  assert.match(html, /animate-spin/);
  assert.doesNotMatch(html, /<button|<ol|<li|父层已接纳|aria-expanded/);
});

test('terminal and stale facts stop the spinner while keeping the brief result or diagnosis visible', () => {
  const html = renderToStaticMarkup(createElement(ConversationProcess, { process: { ...process, active: false, label: '处理完成', notice: '部分调用的结束状态尚未取得。' } }));
  assert.match(html, /处理完成/);
  assert.match(html, /部分调用的结束状态尚未取得/);
  assert.doesNotMatch(html, /animate-spin/);
});
