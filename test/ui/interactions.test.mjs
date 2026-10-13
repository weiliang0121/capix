import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { InteractionCard } from '../../apps/observer/.test-dist/features/inspection/InteractionDetails.js';
import { projectInteraction } from '../../apps/observer/.test-dist/binding/interactions.js';

const requireApp = createRequire(new URL('../../apps/observer/package.json', import.meta.url));
const { createElement } = requireApp('react');
const { renderToStaticMarkup } = requireApp('react-dom/server');
const call = { id: 'call', contextId: 'context', output: { kind: 'pending', interaction: { id: 'interaction' } } };
const value = { id: 'interaction', contract: 'observer.model.v1', revision: 1, delivery: 'started', retained: 'persistent', model: 'fixture-model', purpose: 'answer', result: { kind: 'pending' } };
const relation = (change, childId = call.id) => ({ childId, identity: { childContextId: call.contextId }, change });
const render = (props = {}) => renderToStaticMarkup(createElement(InteractionCard, { view: projectInteraction({ id: value.id, call, value, ...props }) }));

test('a locally finished wait, pending external exchange and parent acceptance remain independent facts', () => {
  const html = render({ parent: { relationEntries: [relation({ kind: 'accepted', output: call.output })] } });
  assert.match(html, /发送已登记，等待外部反馈/);
  assert.match(html, /本次等待已结束，返回时交互尚未取得反馈/);
  assert.match(html, /父层已接纳本次返回/);
  assert.match(html, /fixture-model/);
  assert.match(html, /生成回答/);
  assert.doesNotMatch(html, /反馈已接收|已保存|重新发送|通过校验/);
});

test('late external feedback updates independently and only persistent feedback claims saving', () => {
  const received = { ...value, revision: 2, result: { kind: 'received', feedbackId: 'reply' } };
  const persisted = render({ value: received });
  assert.match(persisted, /反馈已接收并保存/);
  assert.match(persisted, /返回时交互尚未取得反馈/);
  assert.match(persisted, /尚无父层接纳事实/);
  const memory = render({ value: { ...received, retained: 'memory' } });
  assert.match(memory, /反馈已接收（进程内）/);
  assert.doesNotMatch(memory, /已保存|接收并保存/);
});

test('parent explanations use only this child and distinguish observer failure from business rejection', () => {
  const other = render({ parent: { relationEntries: [relation({ kind: 'accepted' }, 'other-call')] } });
  assert.match(other, /尚无父层接纳事实/);
  const receiving = render({ parent: { relationEntries: [relation({ kind: 'returned' }), relation({ kind: 'receiving' })] } });
  assert.match(receiving, /父层正在接纳本次返回/);
  const work = render({ parent: { relationEntries: [relation({ kind: 'failed', source: 'work' })] } });
  assert.match(work, /父层接纳失败/);
  const observation = render({ parent: { relationEntries: [relation({ kind: 'failed', source: 'observation' })] } });
  assert.match(observation, /父层接纳记录不完整/);
  assert.doesNotMatch(observation, /父层接纳失败/);
});

test('missing or interrupted metadata never invents an external or call outcome', () => {
  const unloaded = render({ value: undefined, error: '暂不可用' });
  assert.match(unloaded, /状态尚未取得/);
  assert.match(unloaded, /交互观测中断：暂不可用/);
  assert.doesNotMatch(unloaded, /反馈已接收|交互结果不可用/);
  const unavailable = render({ value: { ...value, result: { kind: 'unavailable', error: { code: 'MODEL_TIMEOUT', message: '外部等待超时' } } } });
  assert.match(unavailable, /交互结果不可用/);
  assert.match(unavailable, /外部等待超时/);
  assert.doesNotMatch(unavailable, /请求未发送/);
});
