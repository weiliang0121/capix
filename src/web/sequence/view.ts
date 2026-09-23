import type { EventRecord } from '../../shared/records.js';
import type { CallSpan, Trace } from '../../shared/types.js';

const ns = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>, text?: string): SVGElementTagNameMap[K] {
  const node = document.createElementNS(ns, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}
function short(value: string, limit = 34) {
  return value.length <= limit ? value : value.slice(0, limit - 1) + '…';
}
function duration(value: number) {
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(1)} ms`;
}
function resultLabel(call: CallSpan): string {
  const output = call.output;
  if (output && typeof output === 'object') {
    if ('historyIndexes' in output) return JSON.stringify((output as { historyIndexes: unknown }).historyIndexes);
    if ('finishReason' in output) return `模型返回 · ${(output as { finishReason: string }).finishReason}`;
    if ('kind' in output) return `${(output as { kind: string }).kind}`;
    if ('message' in output && 'selectedMessages' in output && Array.isArray(output.selectedMessages)) return `当前消息 + ${output.selectedMessages.length} 条已选消息`;
    if ('model' in output && 'messages' in output && Array.isArray(output.messages)) return '完整模型请求';
  }
  return '返回结果';
}

// Rows come only from recorded boundary events, never from the planned stage list.
export function renderSequence(container: HTMLElement, trace: Trace | undefined, selected: string, onSelect: (call: CallSpan, event: EventRecord) => void) {
  container.replaceChildren();
  const sequence = trace?.callSequence;
  if (!sequence?.events.length) {
    const empty = document.createElement('div');
    empty.className = 'sequence-empty';
    empty.textContent = trace ? '记录没有调用时序事件。' : '运行后，从这里向下展开实际调用、返回与异常。未发生的调用不会画入图中。';
    container.append(empty);
    return;
  }
  const width = Math.max(620, container.clientWidth);
  const gutter = 70;
  const lane = (width - gutter - 24) / sequence.participants.length;
  const positions = new Map(sequence.participants.map((p, i) => [p.id, gutter + lane * (i + 0.5)]));
  const sheet = document.createElement('div');
  sheet.className = 'sequence-sheet';
  sheet.style.width = `${width}px`;
  const header = document.createElement('div');
  header.className = 'sequence-head';
  const headerSvg = svg('svg', {
    width,
    height: 64,
    viewBox: `0 0 ${width} 64`,
    role: 'img',
    'aria-label': '时序图参与者',
  });
  headerSvg.append(svg('text', { x: 12, y: 24, class: 'seq-time' }, '顺序 / 时间 ↓'));
  sequence.participants.forEach((p) => {
    const x = positions.get(p.id)!;
    headerSvg.append(
      svg('rect', {
        x: x - lane / 2 + 5,
        y: 7,
        width: lane - 10,
        height: 37,
        rx: 5,
        class: 'seq-participant',
      }),
    );
    const text = svg('text', { x, y: 30, 'text-anchor': 'middle', class: 'seq-participant-text' }, short(p.label, Math.floor((lane - 14) / 6.5)));
    text.append(svg('title', {}, p.description));
    headerSvg.append(text);
    headerSvg.append(svg('line', { x1: x, y1: 44, x2: x, y2: 64, class: 'seq-lifeline' }));
  });
  header.append(headerSvg);
  sheet.append(header);
  const calls = new Map(sequence.calls.map((c) => [c.id, c]));
  const active: CallSpan[] = [];
  for (const event of sequence.events) {
    const call = calls.get(event.callId)!;
    if (event.value.type === 'call') active.push(call);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `sequence-event ${event.value.type}${selected === call.id ? ' is-selected' : ''}`;
    button.dataset.call = call.id;
    button.dataset.event = String(event.sequence);
    const label = event.value.type === 'call' ? call.label : event.value.type === 'throw' ? `抛出 ${call.error?.code ?? 'ERROR'}` : resultLabel(call);
    button.setAttribute('aria-label', `${event.sequence} ${event.value.type === 'call' ? '调用' : event.value.type === 'throw' ? '异常返回' : '返回'} ${call.label}：${label}`);
    const row = svg('svg', {
      width,
      height: 70,
      viewBox: `0 0 ${width} 70`,
      'aria-hidden': 'true',
    });
    sequence.participants.forEach((p) => {
      const x = positions.get(p.id)!;
      row.append(svg('line', { x1: x, y1: 0, x2: x, y2: 70, class: 'seq-lifeline' }));
    });
    const depths = new Map<string, number>();
    for (const item of active) {
      const depth = depths.get(item.callee) ?? 0;
      depths.set(item.callee, depth + 1);
      const first = event.value.type === 'call' && item.id === call.id;
      const last = event.value.type !== 'call' && item.id === call.id;
      row.append(
        svg('rect', {
          x: positions.get(item.callee)! - 4 + depth * 5,
          y: first ? 37 : 0,
          width: 8,
          height: first || last ? (first ? 33 : 37) : 70,
          class: `seq-activation${event.value.type === 'throw' && last ? ' failed' : ''}`,
        }),
      );
    }
    row.append(svg('text', { x: 12, y: 29, class: 'seq-number' }, `#${String(event.sequence).padStart(2, '0')}`));
    row.append(svg('text', { x: 12, y: 46, class: 'seq-time' }, `+${duration(event.offsetMs)}`));
    const fromId = event.value.type === 'call' ? call.caller : call.callee;
    const toId = event.value.type === 'call' ? call.callee : call.caller;
    const from = positions.get(fromId)!;
    const to = positions.get(toId)!;
    const sign = to >= from ? 1 : -1;
    const start = from + sign * 5;
    const end = to - sign * 5;
    row.append(svg('line', { x1: start, y1: 37, x2: end, y2: 37, class: `seq-arrow ${event.value.type}` }));
    row.append(
      svg('path', {
        d: `M ${end - sign * 7} 33 L ${end} 37 L ${end - sign * 7} 41`,
        class: `seq-arrowhead ${event.value.type}`,
      }),
    );
    const mid = (from + to) / 2;
    const charLimit = Math.max(12, Math.floor(Math.abs(to - from) / 7));
    const text = svg('text', { x: mid, y: 23, 'text-anchor': 'middle', class: `seq-label ${event.value.type}` }, short(label, charLimit));
    text.append(svg('title', {}, `${call.label} · ${label}`));
    row.append(text);
    const hint = event.value.type === 'call' ? (call.callee === 'provider' ? 'await · 等待接口返回' : '') : `耗时 ${duration(call.durationMs ?? 0)}`;
    if (hint) row.append(svg('text', { x: mid, y: 59, 'text-anchor': 'middle', class: 'seq-hint' }, hint));
    button.append(row);
    button.addEventListener('click', () => onSelect(call, event));
    sheet.append(button);
    if (event.value.type !== 'call')
      active.splice(
        active.findIndex((c) => c.id === call.id),
        1,
      );
  }
  if (active.length) {
    const waiting = document.createElement('div');
    waiting.className = 'sequence-waiting';
    waiting.textContent = `等待返回：${active.at(-1)!.label}`;
    sheet.append(waiting);
  }
  container.append(sheet);
}
