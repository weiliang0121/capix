import { isPlainObject } from 'es-toolkit/predicate';
import type { InteractionObservation } from '@weiliang0121/capix-protocol';
import type { CallDetail } from '../state/data.js';

export interface InteractionView {
  readonly id: string;
  readonly status: string;
  readonly model?: string;
  readonly purpose?: string;
  readonly waitNotice?: string;
  readonly parentReceipt: string;
  readonly resultError?: string;
  readonly observationNotice?: string;
}

export function hasInteraction(call: Pick<CallDetail, 'resources'>): boolean {
  return call.resources.some((resource) => resource.access === 'model-interaction.create' || resource.access === 'model-interaction.read');
}

/** Explain independent external feedback, local waiting and parent acceptance without merging their outcomes. */
export function projectInteraction({ id, value, error, call, parent }: { id: string; value?: InteractionObservation; error?: string; call: Pick<CallDetail, 'id' | 'contextId' | 'output'>; parent?: Pick<CallDetail, 'relationEntries'> }): InteractionView {
  const pending = isPlainObject(call.output) && call.output.kind === 'pending' && isPlainObject(call.output.interaction) && call.output.interaction.id === id;
  const relation = parent?.relationEntries.filter((entry) => entry.childId === call.id || (!entry.childId && entry.identity.childContextId === call.contextId)).at(-1);
  const parentChange = relation?.change;
  const parentReceipt = parentChange?.kind === 'accepted' ? '父层已接纳本次返回' : parentChange?.kind === 'handled' ? '失败已处理' : parentChange?.kind === 'receiving' ? '父层正在接纳本次返回' : parentChange?.kind === 'failed' ? (parentChange.source === 'observation' ? '父层接纳记录不完整' : '父层接纳失败') : parentChange?.kind === 'returned' ? '本次已返回，尚无父层接纳事实' : '尚无父层接纳事实';
  const status = !value ? '状态尚未取得' : value.result.kind === 'received' ? (value.retained === 'persistent' ? '反馈已接收并保存' : '反馈已接收（进程内）') : value.result.kind === 'unavailable' ? '交互结果不可用' : value.delivery === 'started' ? '发送已登记，等待外部反馈' : '交互已建立，尚未登记发送';
  return {
    id,
    status,
    model: value?.model,
    purpose: value ? (purposeNames[value.purpose] ?? value.purpose) : undefined,
    waitNotice: pending ? '本次等待已结束，返回时交互尚未取得反馈。' : undefined,
    parentReceipt,
    resultError: value?.result.kind === 'unavailable' ? value.result.error.message : undefined,
    observationNotice: error ? `交互观测中断：${error}。保留最后已取得的事实。` : undefined,
  };
}

const purposeNames: Readonly<Record<string, string>> = { selection: '选择历史', understanding: '理解请求', answer: '生成回答', memory: '提取记忆' };
