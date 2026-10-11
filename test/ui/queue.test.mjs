import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Composer } from '../../apps/observer/.test-dist/features/conversation/Composer.js';
import { MessageQueue } from '../../apps/observer/.test-dist/features/conversation/MessageQueue.js';

const requireApp = createRequire(new URL('../../apps/observer/package.json', import.meta.url));
const { createElement } = requireApp('react');
const { renderToStaticMarkup } = requireApp('react-dom/server');
const handlers = { onCancel: async () => {} };
const composer = { configured: true, loaded: true, draft: '', onDraft: () => {}, onSubmit: async () => {}, onCancel: handlers.onCancel };
const current = { id: 'active', label: '停止当前回答', disabled: false };
const renderComposer = (props = {}) => renderToStaticMarkup(createElement(Composer, { ...composer, ...props }));
const control = (html, label) => [...html.matchAll(/<button\b[^>]*>/g)].find(([tag]) => tag.includes(`aria-label="${label}"`))?.[0];

test('send has one label and remains available alongside cancellation while another request is active', () => {
  const html = renderComposer({ current, draft: '下一条消息' });
  assert.match(control(html, '发送消息'), /type="submit"/);
  assert.match(control(html, '停止当前回答'), /type="button"/);
  assert.match(html, /Enter 发送/);
  assert.doesNotMatch(html, /加入队列/);
  assert.doesNotMatch(html, /disabled=/);
});

test('empty active composer replaces send with a non-submit stop control and stays editable', () => {
  const empty = renderComposer({ current });
  assert.equal(control(empty, '发送消息'), undefined);
  assert.match(control(empty, '停止当前回答'), /type="button"/);
  assert.doesNotMatch(control(empty, '停止当前回答'), /disabled=/);
  assert.doesNotMatch(empty, /<textarea[^>]*disabled=/);
  const whitespace = renderComposer({ current, draft: '  ' });
  assert.equal(control(whitespace, '发送消息'), undefined);
  const unavailable = renderComposer({ current, configured: false });
  assert.doesNotMatch(control(unavailable, '停止当前回答'), /disabled=/, 'current cancellation does not depend on model configuration');
});

test('acknowledged cancellation is disabled while uncertain cancellation remains retryable', () => {
  const waiting = renderComposer({ current: { ...current, label: '正在停止当前回答…', disabled: true }, draft: '随后发送' });
  assert.match(control(waiting, '正在停止当前回答…'), /disabled=""/);
  assert.doesNotMatch(control(waiting, '发送消息'), /disabled=/);
  const uncertain = renderComposer({ current: { ...current, label: '重试停止当前回答' } });
  assert.match(control(uncertain, '重试停止当前回答'), /type="button"/);
  assert.doesNotMatch(control(uncertain, '重试停止当前回答'), /disabled=/);
});

test('terminal service has no stop control even if content is still being presented', () => {
  const idle = renderComposer();
  assert.match(control(idle, '发送消息'), /disabled=""/);
  assert.doesNotMatch(idle, /停止当前回答|取消中|重试停止当前回答/);
  const next = renderComposer({ draft: '新问题' });
  assert.doesNotMatch(control(next, '发送消息'), /disabled=/);
});

test('queue only owns waiting input, withdrawal and the actual blocking reason', () => {
  const html = renderToStaticMarkup(
    createElement(MessageQueue, {
      ...handlers,
      queue: {
        waiting: [
          { id: 'next-a', pending: '第一条等待' },
          { id: 'next-b', pending: '第二条等待' },
        ],
        blocked: '正在确认上一条的结果',
      },
    }),
  );
  assert.match(html, /aria-label="发送队列"/);
  assert.match(html, /aria-label="撤回待发送消息 1"/);
  assert.match(html, /aria-label="撤回待发送消息 2"/);
  assert.match(html, /role="status">正在确认上一条的结果/);
  assert.doesNotMatch(html, /恢复队列|暂停队列|清空待发送/);
  assert.doesNotMatch(html, /取消全部|停止当前回答|取消中/);
  assert.ok(html.indexOf('第一条等待') < html.indexOf('第二条等待'));
  assert.doesNotMatch(html, /结束跟踪/);
});

test('an empty queue stays hidden even when the current submission is awaiting confirmation', () => {
  assert.equal(renderToStaticMarkup(createElement(MessageQueue, { ...handlers, queue: { waiting: [] } })), '');
  const blocked = renderToStaticMarkup(createElement(MessageQueue, { ...handlers, queue: { waiting: [], blocked: '上一条结果待确认' } }));
  assert.equal(blocked, '');
  const html = renderComposer({ draft: '随后发送的消息' });
  assert.doesNotMatch(control(html, '发送消息'), /disabled=/);
  assert.doesNotMatch(html, /恢复发送|已暂停|加入队列/);
});
