import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Composer } from '../../apps/observer/.test-dist/features/conversation/Composer.js';
import { MessageQueue } from '../../apps/observer/.test-dist/features/conversation/MessageQueue.js';

const requireApp = createRequire(new URL('../../apps/observer/package.json', import.meta.url));
const { createElement } = requireApp('react');
const { renderToStaticMarkup } = requireApp('react-dom/server');
const handlers = { onCancel: async () => {}, onCancelAll: async () => {}, onClear: () => {}, onPause: () => {}, onResume: () => {} };

test('composer stays editable and can enqueue while another request is active', () => {
  const html = renderToStaticMarkup(createElement(Composer, { configured: true, loaded: true, queueing: true, draft: '下一条消息', onDraft: () => {}, onSubmit: async () => {} }));
  assert.match(html, /aria-label="加入队列"/);
  assert.match(html, /Enter 加入队列/);
  assert.doesNotMatch(html, /disabled=/);
  const empty = renderToStaticMarkup(createElement(Composer, { configured: true, loaded: true, queueing: true, draft: '', onDraft: () => {}, onSubmit: async () => {} }));
  assert.match(empty, /<button[^>]*disabled=""/);
  assert.doesNotMatch(empty, /<textarea[^>]*disabled=/);
});

test('waiting input and current cancellation have separate accessible controls', () => {
  const html = renderToStaticMarkup(
    createElement(MessageQueue, {
      ...handlers,
      queue: {
        waiting: [
          { id: 'next-a', pending: '第一条等待' },
          { id: 'next-b', pending: '第二条等待' },
        ],
        paused: true,
        blocked: '正在确认上一条的结果',
      },
      current: { id: 'active', label: '取消中…', disabled: true },
    }),
  );
  assert.match(html, /aria-label="发送队列"/);
  assert.match(html, /aria-label="撤回待发送消息 1"/);
  assert.match(html, /aria-label="撤回待发送消息 2"/);
  assert.match(html, /role="status">正在确认上一条的结果/);
  assert.match(html, /恢复队列/);
  assert.match(html, /清空待发送/);
  assert.match(html, /取消全部/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>取消中…/);
  assert.ok(html.indexOf('第一条等待') < html.indexOf('第二条等待'));
  assert.doesNotMatch(html, /结束跟踪/);
});

test('empty running queue stays out of the conversation while a paused queue can resume', () => {
  assert.equal(renderToStaticMarkup(createElement(MessageQueue, { ...handlers, queue: { waiting: [], paused: false } })), '');
  const paused = renderToStaticMarkup(createElement(MessageQueue, { ...handlers, queue: { waiting: [], paused: true } }));
  assert.match(paused, /恢复队列/);
  assert.doesNotMatch(paused, /取消全部|清空待发送/);
});
