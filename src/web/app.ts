import { projectExecution } from '../shared/execution/project.js';
import { readOutput } from '../shared/records/invocation.js';
import { MemoryView } from './memory/view.js';
import { MessageDraft } from './messages/draft.js';
import { renderSequence, duration, timedTraces, layoutTimeline, mapTimelinePosition, wheelIntent, laneWidth, QAOverview, type TimelineLayout } from './sequence/view.js';
import type { ExecutionObservation } from '../shared/observation/execution.js';
import type { MemoryObservation } from '../shared/observation/memory.js';
import type { Trace, CallSpan, TraceMessage, ExecutionRequest, Message } from '../shared/types.js';

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}
const messageInput = el<HTMLTextAreaElement>('messageInput'),
  historyEditor = el<HTMLTextAreaElement>('history'),
  budget = el<HTMLInputElement>('budget');
const diagram = el('sequence'),
  inspector = el<HTMLDialogElement>('inspect-dialog'),
  settingsDialog = el<HTMLDialogElement>('settings-dialog');
const traces = new Map<string, Trace>();
let observation: ExecutionObservation = { messages: [], executions: [] },
  memories: MemoryObservation = { items: [] };
let acceptedMessages: readonly Message[] = [],
  selectedExecution = '',
  selectedCall = '',
  focus = '',
  zoom = 1,
  busy = false,
  configured = false;
let detail: { trace: Trace; call?: CallSpan } | undefined,
  tab = 'overview',
  sourceTicket = 0,
  pendingMessage = '';
let timeline: TimelineLayout | undefined;
const overview = new QAOverview(el('qa-overview'), diagram, (id) => {
  selectedExecution = id;
  selectedCall = '';
  focusTimeline(id);
  renderOutcome();
  renderHistory();
});
const sourceCache = new Map<string, string>();
const labels: Record<string, string> = { running: '运行中', passed: '成功', succeeded: '成功', failed: '失败' };
function pretty(value: unknown) {
  return value === undefined ? '尚无记录' : JSON.stringify(value, null, 2);
}
function notice(text = '') {
  el('notice').textContent = text;
}
function block(title: string, value: unknown) {
  const b = element('section', 'data-block');
  b.append(element('h3', '', title), element('pre', '', pretty(value)));
  return b;
}
function contentBlock(title: string, content: string) {
  const b = element('section', 'text-block');
  b.append(element('h3', '', title), element('p', '', content));
  return b;
}
function button(text: string, action: () => void, cls = '') {
  const b = element('button', cls, text);
  b.type = 'button';
  b.onclick = action;
  return b;
}
function selectedTrace() {
  return traces.get(selectedExecution);
}
function qaNumber(trace: Trace) {
  return timedTraces([...traces.values()]).findIndex((t) => t.trace.id === trace.id) + 1;
}
function renderGraph() {
  timeline = renderSequence(diagram, { traces: [...traces.values()], observation, memories, selectedExecution, selectedCall, zoom, select: openDetail });
  overview.update(timeline, observation, memories, selectedExecution);
  el('zoom-label').textContent = `${Number(zoom.toFixed(2))}×`;
  el<HTMLButtonElement>('zoom-out').disabled = zoom <= 1;
  el<HTMLButtonElement>('zoom-in').disabled = zoom >= 64;
  const times = timedTraces([...traces.values()]);
  el('graph-summary').textContent = times.length ? `${times.length} 轮 QA · ${times.reduce((n, t) => n + t.trace.nodes.length, 0)} 次调用 · 跨度 ${duration(Math.max(...times.map((t) => t.end)) - times[0]!.start)}` : '等待第一条记录';
}
function renderRanges() {
  const select = el<HTMLSelectElement>('time-range');
  select.replaceChildren(new Option('全部 QA · 折叠间隔', ''));
  for (const [i, { trace }] of timedTraces([...traces.values()]).entries()) select.add(new Option(`聚焦 QA ${String(i + 1).padStart(2, '0')} · ${duration(trace.durationMs)}`, trace.id));
  select.value = focus;
}
function renderHistory(forceBottom = false) {
  const root = el('history-preview');
  const atBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 60,
    oldTop = root.scrollTop;
  root.replaceChildren();
  el('history-count').textContent = `${acceptedMessages.length} 条消息`;
  if (!acceptedMessages.length && !pendingMessage) {
    const empty = element('div', 'chat-empty');
    empty.append(element('span', 'empty-symbol', '↗'), element('h3', '', '从一个问题开始'), element('p', '', '每轮对话的运行过程会出现在左侧。'));
    root.append(empty);
  }
  acceptedMessages.forEach((message, index) => {
    const qa = observation.executions.find((e) => e.inputIndex === index || e.response?.index === index);
    const row = element('article', `chat-message ${message.role}${qa?.id === selectedExecution ? ' selected' : ''}`);
    row.dataset.message = String(index);
    const head = element('div', 'message-head');
    head.append(element('span', '', message.role === 'user' ? '你' : '助手'), element('span', '', `[${index}]`));
    if (qa) {
      row.dataset.execution = qa.id;
      head.append(
        button(
          `QA ${String(observation.executions.indexOf(qa) + 1).padStart(2, '0')} ↗`,
          () => {
            const trace = traces.get(qa.id);
            if (trace) openDetail(trace);
          },
          'message-link',
        ),
      );
    }
    row.append(head, element('p', 'message-content', message.content));
    root.append(row);
  });
  if (pendingMessage) root.append(contentBlock('发送中', pendingMessage));
  if (busy) root.append(element('p', 'chat-progress', '运行中 · 左侧记录持续更新…'));
  root.scrollTop = forceBottom || atBottom ? root.scrollHeight : oldTop;
}
function renderOutcome() {
  const trace = selectedTrace();
  const outcome = el('outcome');
  outcome.className = `outcome${trace?.error ? ' error' : ''}`;
  outcome.textContent = trace?.error ? `${trace.error.code} · ${trace.error.message}` : trace?.result ? `QA ${String(qaNumber(trace)).padStart(2, '0')} · ${trace.result.kind} · ${duration(trace.durationMs)} · 点击图中节点查看证据` : busy ? '执行中，长度截至最近一条记录。' : '消息短条表示累计被选次数；调用宽度表示耗时。';
  if (trace?.error && trace.nodes.some((n) => n.operation === 'answer' && n.status === 'passed')) outcome.textContent += ' 回答已保留，后续处理未完成。';
}
function render() {
  el('trace-status').textContent = busy ? '运行中' : traces.size ? `${traces.size} 轮 QA` : '尚未运行';
  el<HTMLButtonElement>('run').disabled = busy || !configured;
  el<HTMLTextAreaElement>('messageInput').disabled = busy;
  el('run').textContent = busy ? '运行中…' : '发送 ↑';
  el('memory-count').textContent = String(memories.items.length);
  renderOutcome();
  renderRanges();
  renderGraph();
  if (inspector.open && detail) {
    const latest = traces.get(detail.trace.id);
    if (latest) {
      detail = { trace: latest, call: detail.call ? latest.callSequence!.calls.find((c) => c.id === detail!.call!.id) : undefined };
      renderDetail();
    }
  }
}
function openDetail(trace: Trace, call?: CallSpan) {
  detail = { trace, call };
  selectedExecution = trace.id;
  selectedCall = call?.id ?? '';
  tab = 'overview';
  sourceTicket++;
  render();
  renderHistory();
  renderDetail();
  if (!inspector.open) inspector.showModal();
}
function callList(trace: Trace, parentId: string) {
  const root = element('div', 'call-list');
  for (const call of trace.callSequence!.calls.filter((c) => c.parentId === parentId)) {
    const b = button('', () => openDetail(trace, call), 'child-call');
    const meta = element('span', 'node-meta');
    meta.append(element('span', `status-tag ${call.status}`, labels[call.status]), element('span', '', `${duration(call.durationMs ?? 0)}  ↗`));
    b.append(element('span', '', `${call.recordType === 'attempt' ? 'A' : 'O'} · ${call.label}`), meta);
    root.append(b);
  }
  return root;
}
function pair(trace: Trace) {
  const qa = observation.executions.find((q) => q.id === trace.id);
  const input = trace.facts.execution.value.input as Message;
  const output = qa?.response?.content ?? (trace.nodes.find((n) => n.operation === 'answer' && n.status === 'passed')?.output as { content?: string } | undefined)?.content;
  const grid = element('div', 'data-grid');
  grid.append(contentBlock(`用户${qa ? ` · [${qa.inputIndex}]` : ''}`, input.content), contentBlock(`助手${qa?.response?.index !== undefined ? ` · [${qa.response.index}]` : ''}`, output ?? '本轮尚无已记录的回答。'));
  return grid;
}
function renderDetail() {
  if (!detail) return;
  const { trace, call } = detail;
  const body = el('detail-body');
  el('detail-kicker').textContent = `QA ${String(qaNumber(trace)).padStart(2, '0')} / ${call?.recordType.toUpperCase() ?? 'CONVERSATION'}`;
  el('detail-title').textContent = call?.label ?? '这一轮交流';
  const status = call?.status ?? trace.status;
  el('detail-status').replaceChildren(element('span', `status-tag ${status}`, labels[status]), element('span', '', `${duration(call?.durationMs ?? trace.durationMs)} · ${new Date(trace.startedAt).toLocaleTimeString()}`));
  const meta = el('detail-meta');
  meta.replaceChildren();
  meta.append(
    button('聚焦此轮时间', () => {
      focusTimeline(trace.id);
      inspector.close();
    }),
  );
  if (call)
    meta.append(
      button('返回 QA', () => openDetail(trace)),
      element('span', 'identity', `记录 ${call.id} · Context ${call.contextId}`),
    );
  else meta.append(element('span', 'identity', `Execution ${trace.id}`));
  const tabs = el('detail-tabs');
  tabs.replaceChildren();
  const choices = call
    ? [
        ['overview', '概览 / IO'],
        ['process', '内部过程'],
        ['context', '上下文'],
        ['memory', '记忆'],
        ['source', '执行源码'],
      ]
    : [
        ['overview', '交流 / 调用'],
        ['context', '上下文'],
        ['memory', '记忆'],
      ];
  for (const [id, label] of choices) {
    const b = button(label!, () => {
      tab = id!;
      renderDetail();
    });
    b.setAttribute('aria-pressed', String(tab === id));
    tabs.append(b);
  }
  body.replaceChildren();
  if (tab === 'overview') {
    if (!call) {
      body.append(pair(trace));
      const qa = observation.executions.find((q) => q.id === trace.id);
      body.append(element('h3', 'section-heading', '历史选择'));
      for (const selection of qa?.selections ?? []) {
        body.append(element('p', 'subtle', selection.indexes ? `选择顺序：${selection.indexes.map((i) => `[${i}]`).join(' → ') || '未选择历史'}` : `筛选${labels[selection.status]}`));
      }
      body.append(
        button(
          `E · Execution · ${duration(trace.durationMs)} ↗`,
          () =>
            openDetail(
              trace,
              trace.callSequence!.calls.find((c) => c.id === trace.id)!,
            ),
          'child-call',
        ),
        callList(trace, trace.id),
      );
    } else {
      const stats = element('div', 'detail-stats');
      stats.append(contentBlock('开始位置', `+${duration(call.offsetMs)}`), contentBlock('本地执行轮数', String(Math.max(0, ...call.processes.map((p) => p.round)))), contentBlock('调用目标', call.target ?? call.callee));
      body.append(stats);
      const grid = element('div', 'data-grid');
      grid.append(block('INPUT · 本次输入', call.input), block(call.error ? 'ERROR · 失败原因' : 'OUTPUT · 最终结果', call.error ?? call.output));
      body.append(grid);
      const children = callList(trace, call.id);
      if (children.childElementCount) body.append(element('h3', 'section-heading', '子调用 · 按实际发生顺序'), children);
      if (call.parentId) {
        const parent = trace.callSequence!.calls.find((c) => c.id === call.parentId);
        if (parent) body.append(button(`↑ 父调用 · ${parent.label}`, () => openDetail(trace, parent), 'text-button'));
      }
    }
  } else if (tab === 'process' && call) {
    body.append(element('p', 'subtle', '同一次调用内的执行与接收过程。resultOf 读取本条记录中已冻结的结果，不额外创建记录。'));
    for (const process of call.processes) {
      const item = element('details', 'process-item');
      const summary = element('summary');
      summary.append(element('span', 'process-number', `#${process.sequence}`), element('strong', '', `${process.stage}.${process.type}`), element('span', '', `第 ${process.round} 轮 · +${duration(process.offsetMs)}`));
      item.append(summary);
      const result = 'resultOf' in process ? call.processes.find((p) => p.sequence === process.resultOf) : undefined;
      item.append(block('过程记录', process));
      if (result && 'output' in result) item.append(block(`复用 #${result.sequence} 的结果`, result.output));
      body.append(item);
    }
    if (!call.processes.length) body.append(element('p', 'subtle', '本次调用没有内部过程条目。'));
  } else if (tab === 'context') {
    body.append(element('p', 'subtle', '以下是记录捕获的上下文信息，不是当前可变 Context 的实时副本。配置与消息范围归属本次 Execution。'));
    body.append(block('调用关联', { contextId: call?.contextId ?? trace.facts.execution.contextId, executionRecordId: trace.id, parentRecordId: call?.parentId, operationInstanceId: call?.operationInstanceId }));
    body.append(block('执行配置快照', trace.facts.execution.value.settings), block('执行消息范围', trace.facts.execution.value.transcriptRange));
  } else if (tab === 'memory') {
    const owner = call?.recordType === 'attempt' ? trace.facts.operations.find((o) => o.id === call.parentId) : call?.recordType === 'operation' ? trace.facts.operations.find((o) => o.id === call.id) : trace.facts.operations.find((o) => o.operation === 'selection');
    const input = owner?.value.input as { memories?: readonly { id: string; topic: string; content: string; sourceIndexes: readonly number[] }[] } | undefined;
    const comparison = element('div', 'data-grid memory-comparison');
    const incoming = element('section');
    incoming.append(element('h3', 'section-heading', call?.recordType === 'attempt' ? '所属操作传入的记忆' : '本次传入的记忆'));
    incoming.append(element('p', 'panel-note', '当时的内容 · 传入不等于被模型采用'));
    const inputs = element('div', 'memory-grid');
    for (const memory of input?.memories ?? []) {
      const card = element('article', 'memory-card');
      card.append(element('span', 'card-tag', '输入快照'), element('h3', 'card-title', memory.topic), element('p', 'card-content', memory.content));
      card.append(element('p', 'record-evidence', `原文依据 ${memory.sourceIndexes.map((i) => `[${i}]`).join(' ')} · ${memory.id.slice(0, 8)}`));
      inputs.append(card);
    }
    if (!inputs.childElementCount) inputs.append(element('p', 'subtle', '本次没有传入记忆。'));
    incoming.append(inputs);
    const relevant: MemoryObservation = { items: memories.items.map((m) => ({ ...m, records: m.records.filter((r) => r.executionId === trace.id && (!call || call.recordType === 'execution' || r.operationId === owner?.id)) })) };
    const root = element('section', '');
    comparison.append(incoming, root);
    body.append(comparison);
    const view = new MemoryView(root);
    view.update(relevant);
    view.selectExecution(trace.id);
  } else if (tab === 'source' && call) {
    body.append(element('p', 'subtle', call.source));
    const pre = element('pre', 'source-code', '读取本地源码…');
    body.append(pre);
    void loadSource(call, pre);
  }
}
async function loadSource(call: CallSpan, pre: HTMLElement) {
  const ticket = ++sourceTicket;
  const file = call.source.split(' · ')[0]!.replace(/^src\/server\//, '');
  try {
    let text = sourceCache.get(file);
    if (text === undefined) {
      const response = await fetch(`/api/source?file=${encodeURIComponent(file)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      text = data.content as string;
      sourceCache.set(file, text);
    }
    if (ticket === sourceTicket && pre.isConnected)
      pre.textContent = text
        .split('\n')
        .map((line, i) => `${String(i + 1).padStart(3)}  ${line}`)
        .join('\n');
  } catch (error) {
    if (ticket === sourceTicket && pre.isConnected) pre.textContent = (error as Error).message;
  }
}
async function fetchJSON(path: string) {
  const response = await fetch(path);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `读取失败：${path}`);
  return data;
}
async function refreshObservations() {
  const [messages, executions, memory] = await Promise.all([fetchJSON('/api/transcript'), fetchJSON('/api/executions'), fetchJSON('/api/memory')]);
  acceptedMessages = new MessageDraft(messages.messages).snapshot();
  observation = executions;
  memories = memory;
  renderHistory();
}
function streamObservation(trace: Trace) {
  const range = trace.facts.execution.value.transcriptRange as { end: number } | undefined;
  let item = observation.executions.find((e) => e.id === trace.id);
  if (!item) {
    item = { id: trace.id, startedAt: trace.startedAt, status: trace.status, inputIndex: (range?.end ?? acceptedMessages.length) - 1, selections: [] };
    observation.executions.push(item);
  }
  item.status = trace.status;
  item.selections = trace.facts.operations.filter((o) => o.operation === 'selection').map((o) => ({ operationId: o.id, status: o.status, ...(o.status === 'succeeded' ? { indexes: (readOutput(o.value) as { historyIndexes: number[] }).historyIndexes } : {}) }));
  const response = trace.facts.operations.find((o) => o.operation === 'answer' && o.status === 'succeeded');
  if (response) item.response = { content: (readOutput(response.value) as { content: string }).content };
}
async function execute(payload: ExecutionRequest & { contextBudget: number }) {
  busy = true;
  pendingMessage = payload.messages.at(-1)!.content;
  notice();
  renderHistory(true);
  render();
  let received = false,
    accepted = false;
  try {
    const response = await fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error ?? `HTTP ${response.status}`);
    }
    accepted = true;
    historyEditor.value = '[]';
    messageInput.value = '';
    if (!response.body) throw new Error('服务未返回记录流。');
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let buffer = '';
    const consume = (line: string) => {
      if (!line.trim()) return;
      const item = JSON.parse(line) as TraceMessage;
      if (item.type !== 'trace') return;
      const trace = projectExecution(item.trace);
      traces.set(trace.id, trace);
      selectedExecution = trace.id;
      if (!received) {
        selectedCall = '';
        focus = '';
        renderRanges();
      }
      received = true;
      streamObservation(trace);
      render();
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        if (buffer.trim()) consume(buffer);
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    }
    if (!received || selectedTrace()?.status === 'running') throw new Error('记录流提前断开，未获得完成结果，不能视为成功。');
  } catch (error) {
    notice((error as Error).message);
  } finally {
    pendingMessage = '';
    busy = false;
    if (accepted) {
      try {
        await refreshObservations();
      } catch (error) {
        notice((error as Error).message);
      }
    }
    renderHistory(true);
    render();
  }
}
el<HTMLFormElement>('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  if (busy || !configured) return;
  try {
    if (!messageInput.value.trim()) throw new Error('请先填写消息。');
    const contextBudget = Number(budget.value);
    if (!Number.isSafeInteger(contextBudget) || contextBudget < 256 || contextBudget > 1000000) throw new Error('容量预算需要是 256–1000000 的整数。');
    void execute({ messages: [...new MessageDraft(JSON.parse(historyEditor.value)).snapshot(), { role: 'user', content: messageInput.value }], contextBudget });
  } catch (error) {
    notice((error as Error).message);
  }
});
messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    el<HTMLFormElement>('composer').requestSubmit();
  }
});
el('settings-open').onclick = () => settingsDialog.showModal();
el('settings-close').onclick = () => settingsDialog.close();
el('inspect-close').onclick = () => inspector.close();
for (const dialog of [inspector, settingsDialog])
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    }
  });
el('sample').onclick = () => {
  historyEditor.value = JSON.stringify(
    [
      { role: 'user', content: '天气怎么样？' },
      { role: 'assistant', content: '你想查询哪个城市？' },
    ],
    null,
    2,
  );
  messageInput.value = '上海';
  notice('样例将在下一次调用时追加。');
};
function clearFocus() {
  if (!focus) return;
  focus = '';
  el<HTMLSelectElement>('time-range').value = '';
}
function panTimeline(x: number) {
  clearFocus();
  diagram.scrollLeft = x;
  overview.sync();
}
function zoomTimeline(next: number, anchor = (diagram.clientWidth - laneWidth) / 2) {
  if (!timeline) return;
  const previous = timeline;
  const point = diagram.scrollLeft + Math.max(0, anchor);
  clearFocus();
  zoom = Math.max(1, Math.min(64, next));
  renderGraph();
  diagram.scrollLeft = mapTimelinePosition(point, previous, timeline!) - Math.max(0, anchor);
  overview.sync();
}
function focusTimeline(id: string) {
  const viewport = Math.max(1, diagram.clientWidth - laneWidth);
  const base = layoutTimeline(timedTraces([...traces.values()]), viewport, 1);
  const item = base.segments.find((s) => s.trace.id === id);
  focus = item ? id : '';
  zoom = item?.width ? Math.max(1, Math.min(64, viewport / item.width)) : 1;
  renderRanges();
  renderGraph();
  diagram.scrollLeft = timeline?.segments.find((s) => s.trace.id === id)?.x ?? 0;
  overview.sync();
}
el('time-range').onchange = () => focusTimeline(el<HTMLSelectElement>('time-range').value);
el('zoom-in').onclick = () => zoomTimeline(zoom * 2);
el('zoom-out').onclick = () => zoomTimeline(zoom / 2);
el('fit').onclick = () => focusTimeline('');
diagram.addEventListener('scroll', () => overview.sync(), { passive: true });
let wheelFrame = 0,
  pendingPan = 0,
  pendingZoom = 0,
  wheelAnchor = 0;
diagram.addEventListener(
  'wheel',
  (event) => {
    if (!timeline) return;
    event.preventDefault();
    const intent = wheelIntent(event.deltaX, event.deltaY, event.deltaMode, diagram.clientWidth - laneWidth);
    pendingPan += intent.pan;
    pendingZoom += intent.zoom;
    wheelAnchor = Math.max(0, event.clientX - diagram.getBoundingClientRect().left - laneWidth);
    if (wheelFrame) return;
    wheelFrame = requestAnimationFrame(() => {
      if (pendingZoom) zoomTimeline(zoom * Math.exp(-Math.max(-1000, Math.min(1000, pendingZoom)) * 0.002), wheelAnchor);
      if (pendingPan) panTimeline(diagram.scrollLeft + pendingPan);
      pendingPan = pendingZoom = wheelFrame = 0;
    });
  },
  { passive: false },
);
el('memory-overview').onclick = () => {
  detail = undefined;
  sourceTicket++;
  el('detail-kicker').textContent = 'MEMORY';
  el('detail-title').textContent = '当前记忆总览';
  el('detail-status').textContent = `${memories.items.length} 个记忆体 · 当前运行事实`;
  el('detail-meta').replaceChildren();
  el('detail-tabs').replaceChildren();
  const root = el('detail-body');
  const view = new MemoryView(root);
  view.update(memories);
  inspector.showModal();
};
let width = 0,
  height = 0;
new ResizeObserver(() => {
  if (diagram.clientWidth !== width || diagram.clientHeight !== height) {
    width = diagram.clientWidth;
    height = diagram.clientHeight;
    renderGraph();
  }
}).observe(diagram);
async function init() {
  renderHistory();
  render();
  try {
    const config = await fetchJSON('/api/config');
    configured = config.configured;
    budget.value = String(config.contextBudget);
    el('connection').textContent = `${config.model} · ${configured ? '已连接' : '待配置 Key'}`;
    el('key-note').hidden = configured;
    await refreshObservations();
    await Promise.all(
      observation.executions.map(async (e) => {
        const trace = projectExecution(await fetchJSON(`/api/execution?id=${encodeURIComponent(e.id)}`));
        traces.set(trace.id, trace);
      }),
    );
    selectedExecution = observation.executions.at(-1)?.id ?? '';
    renderHistory(true);
    render();
  } catch (error) {
    notice((error as Error).message);
    el('connection').textContent = '观测数据加载失败';
  }
}
void init();
