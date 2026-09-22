import { projectExecution } from '../shared/execution/project.js';
import { MessageDraft } from './messages/draft.js';
import type { Trace, TraceNode, TraceMessage, QueryRequest } from '../shared/types.js';
import { renderSequence } from './sequence/view.js';

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
const query = el<HTMLTextAreaElement>('query');
const historyEditor = el<HTMLTextAreaElement>('history');
const budget = el<HTMLInputElement>('budget');
const diagram = el('sequence');
const inspector = el<HTMLDialogElement>('inspect-dialog');
const statusLabels = {
  running: '进行中',
  passed: '通过',
  failed: '失败',
};
const groupLabels = { flow: '流程', selection: '前文选择', answer: '回答生成' };
let trace: Trace | undefined;
let selected = '';
let busy = false;
let configured = false;
let codeTab = false;
let sourceRequest = 0;
let sourceCache = new Map<string, string>();
const archive: Trace[] = [];
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function pretty(value: unknown) {
  return value === undefined ? '尚无记录' : JSON.stringify(value, null, 2);
}
function ms(value?: number) {
  return value === undefined ? '—' : value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(1)} ms`;
}
function notice(message = '') {
  el('notice').textContent = message;
}
function readMessageDraft(): MessageDraft {
  return new MessageDraft(JSON.parse(historyEditor.value));
}
function renderHistory() {
  const preview = el('history-preview');
  preview.replaceChildren();
  try {
    const items = readMessageDraft().snapshot();
    el('history-count').textContent = `${items.length} 条`;
    if (!items.length) preview.append(element('p', 'empty-small', '暂无前文。也可以载入“询问城市 → 上海”的澄清样例。'));
    items.forEach((message, index) => {
      const row = element('div', `message ${message.role}`);
      row.append(element('span', 'role', `[${index}] ${message.role === 'user' ? 'USER' : 'ASSISTANT'}`), element('span', '', message.content));
      preview.append(row);
    });
    notice();
  } catch (error) {
    el('history-count').textContent = '格式有误';
    notice((error as Error).message);
  }
}
function renderDiagram() {
  renderSequence(diagram, trace, selected, (call, event) => {
    selected = call.id;
    const [from, to] = event.type === 'call' ? [call.caller, call.callee] : [call.callee, call.caller];
    el('detail-event').textContent = `事件 #${event.sequence} · ${event.type} · +${ms(event.offsetMs)} · ${from} → ${to}${call.parentId ? ` · 父调用 ${call.parentId}` : ''}`;
    renderDetail();
    renderDiagram();
    if (!inspector.open) inspector.showModal();
  });
}
function selectedRecord(): TraceNode | undefined {
  return trace?.nodes.find((node) => node.id === selected);
}
function renderDetail() {
  const node = selectedRecord();
  el('detail-title').textContent = node ? `${groupLabels[node.group]} / ${node.recordType} / ${node.label}` : '节点详情';
  el('detail-status').textContent = node ? `${statusLabels[node.status]} · ${ms(node.durationMs)}` : '';
  el('detail-source').textContent = node ? `${node.id} → ${node.source}\nContext：${node.contextId}${node.executionId ? `\n执行记录：${node.executionId}${node.operationInstanceId ? ` · 操作实例：${node.operationInstanceId}` : ''}` : ''}` : '运行之后，点击节点查看真实输入输出。';
  el('detail-input').textContent = pretty(node?.input);
  el('detail-output').textContent = node?.error ? pretty({ error: node.error }) : pretty(node?.output);
  if (codeTab) void renderCode(node);
}
async function renderCode(node?: TraceNode) {
  const ticket = ++sourceRequest;
  const file = node?.source.split(' · ')[0]?.replace(/^src\/server\//, '');
  if (!file) {
    el('source-code').textContent = '选择一条实际记录的节点后查看源码。';
    return;
  }
  el('source-code').textContent = '读取本地源码…';
  try {
    let content = sourceCache.get(file);
    if (!content) {
      const res = await fetch(`/api/source?file=${encodeURIComponent(file)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      content = data.content;
      sourceCache.set(file, content!);
    }
    if (ticket === sourceRequest)
      el('source-code').textContent = content!
        .split('\n')
        .map((line, i) => `${String(i + 1).padStart(3)}  ${line}`)
        .join('\n');
  } catch (error) {
    if (ticket === sourceRequest) el('source-code').textContent = (error as Error).message;
  }
}
function renderArchive() {
  const list = el('archive-list');
  list.replaceChildren();
  el('archive-count').textContent = String(archive.length);
  for (const item of [...archive].reverse()) {
    const button = element('button', `archive-item${item.id === trace?.id ? ' active' : ''}`);
    button.disabled = busy;
    button.append(element('span', '', item.request?.query ?? item.id), element('span', '', item.status === 'succeeded' ? '完成' : '失败'));
    button.addEventListener('click', () => {
      trace = item;
      selected = item.nodes.find((n) => n.status === 'failed')?.id ?? trace.id;
      render();
    });
    list.append(button);
  }
}
function render() {
  el<HTMLButtonElement>('run').disabled = busy || !configured;
  el<HTMLButtonElement>('sample').disabled = busy;
  el<HTMLButtonElement>('continue').disabled = busy;
  el('trace-status').textContent = !trace ? '尚未运行' : trace.status === 'running' ? '运行中' : trace.status === 'succeeded' ? '处理完成' : '已停止';
  el('trace-id').textContent = trace ? `${trace.id.slice(0, 8)} · ${new Date(trace.startedAt).toLocaleTimeString()}` : '等待第一条真实记录';
  el('trace-duration').textContent = trace ? ms(trace.durationMs) : '—';
  const outcome = el('outcome');
  outcome.className = trace?.error ? 'outcome error' : 'outcome';
  outcome.textContent = trace?.error ? `${trace.error.code} · ${trace.error.message}` : trace?.result ? `返回 ${trace.result.kind} · 处理链完成不等于问题已解决；可查看实际返回内容。` : trace ? '正在执行；记录在每个处理边界实时更新。' : '每个节点都会保留当时的输入、输出与停止原因。';
  el('answer-box').hidden = !trace?.result;
  if (trace?.result) {
    el('answer-kind').textContent = trace.result.kind;
    el('answer-text').textContent = trace.result.content;
  }
  renderDiagram();
  renderDetail();

  renderArchive();
}
function remember(record: Trace) {
  const index = archive.findIndex((t) => t.id === record.id);
  if (index < 0) archive.push(record);
  else archive[index] = record;
  if (archive.length > 12) archive.shift();
}
async function execute(payload: QueryRequest & { contextBudget: number }) {
  busy = true;
  notice();
  trace = undefined;
  selected = '';
  render();
  let received = false;
  try {
    const response = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    if (!response.body) throw new Error('服务未返回记录流。');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const consume = (line: string) => {
      if (!line.trim()) return;
      const item = JSON.parse(line) as TraceMessage;
      if (item.type !== 'trace') return;
      trace = projectExecution(item.trace);
      trace.request = { query: payload.query, history: payload.history };
      received = true;
      if (trace.status !== 'running') {
        selected = trace.nodes.find((n) => n.status === 'failed')?.id ?? trace.id;
        remember(trace);
      }
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
    const current = trace as Trace | undefined;
    if (!received || current?.status === 'running') throw new Error('记录流提前断开，未获得完成结果；不能视为成功。');
  } catch (error) {
    notice((error as Error).message);
  } finally {
    busy = false;
    render();
  }
}
el('run').addEventListener('click', () => {
  try {
    if (!query.value.trim()) throw new Error('请先填写当前输入。');
    const contextBudget = Number(budget.value);
    if (!Number.isSafeInteger(contextBudget) || contextBudget < 256 || contextBudget > 1000000) throw new Error('容量预算需要是 256–1000000 的整数。');
    void execute({ query: query.value, history: readMessageDraft().snapshot(), contextBudget });
  } catch (error) {
    notice((error as Error).message);
  }
});
el('sample').addEventListener('click', () => {
  historyEditor.value = JSON.stringify(
    [
      { role: 'user', content: '天气怎么样？' },
      { role: 'assistant', content: '你想查询哪个城市？' },
    ],
    null,
    2,
  );
  query.value = '上海';
  renderHistory();
});
historyEditor.addEventListener('change', renderHistory);
el('continue').addEventListener('click', () => {
  if (!trace?.result || !trace.request) return;
  const draft = new MessageDraft(trace.request.history);
  draft.append({ role: 'user', content: trace.request.query }, { role: 'assistant', content: trace.result.content });
  historyEditor.value = JSON.stringify(draft.snapshot(), null, 2);
  query.value = '';
  renderHistory();
  query.focus();
  notice('已加入本轮问答；填写下一条输入后运行。');
});
el('inspect-close').addEventListener('click', () => inspector.close());
let lastDiagramWidth = 0;
new ResizeObserver(() => {
  if (diagram.clientWidth !== lastDiagramWidth) {
    lastDiagramWidth = diagram.clientWidth;
    renderDiagram();
  }
}).observe(diagram);
el('tab-data').addEventListener('click', () => toggleCode(false));
el('tab-code').addEventListener('click', () => toggleCode(true));
function toggleCode(value: boolean) {
  codeTab = value;
  el('tab-data').setAttribute('aria-selected', String(!value));
  el('tab-code').setAttribute('aria-selected', String(value));
  el('detail-data').hidden = value;
  el('detail-code').hidden = !value;
  renderDetail();
}
async function init() {
  renderHistory();
  render();
  try {
    const response = await fetch('/api/config');
    if (!response.ok) throw new Error('无法读取服务配置。');
    const config = await response.json();
    configured = config.configured;
    budget.value = String(config.contextBudget);
    el('connection').textContent = `${config.model} · ${configured ? '已配置 Key' : '待配置 Key'}`;
    el('key-note').hidden = configured;
    render();
  } catch (error) {
    notice((error as Error).message);
    el('connection').textContent = '本地服务未连接';
  }
}
void init();
