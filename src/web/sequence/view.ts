import type { Trace, CallSpan } from '../../shared/types.js';
import type { ExecutionObservation } from '../../shared/observation/execution.js';
import type { MemoryObservation } from '../../shared/observation/memory.js';

export interface TimelineOptions {
  traces: readonly Trace[];
  observation: ExecutionObservation;
  memories: MemoryObservation;
  selectedExecution: string;
  selectedCall: string;
  zoom: number;
  select: (trace: Trace, call?: CallSpan) => void;
}
export interface TimedTrace {
  trace: Trace;
  start: number;
  end: number;
  base: number;
}
/** Anchor each execution to its first wall-clock event; retain monotonic offsets within it. */
export function timedTraces(traces: readonly Trace[]): TimedTrace[] {
  return traces
    .map((trace) => {
      const first = trace.facts.events[0]!;
      const base = Date.parse(first.occurredAt) - first.offsetMs;
      return { trace, base, start: base + first.offsetMs, end: base + trace.durationMs };
    })
    .sort((a, b) => a.start - b.start);
}
export function duration(value: number): string {
  return value >= 60000 ? `${(value / 60000).toFixed(1)} min` : value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(1)} ms`;
}
function tag(status: string, label: string) {
  return el('span', `status-tag ${status}`, label);
}
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') {
  const node = document.createElement(tag);
  node.className = cls;
  node.textContent = text;
  return node;
}
export const laneWidth = 128;
export const qaGap = 24;
export interface TimelineSegment extends TimedTrace {
  x: number;
  width: number;
}
export interface TimelineLayout {
  segments: TimelineSegment[];
  width: number;
  scale: number;
}
/** A common within-QA time scale, with fixed pixel gaps instead of wall-clock waiting. */
export function layoutTimeline(times: readonly TimedTrace[], viewport: number, zoom: number): TimelineLayout {
  const gaps = Math.max(0, times.length - 1) * qaGap;
  const total = times.reduce((sum, item) => sum + Math.max(0, item.end - item.start), 0);
  const scale = (Math.max(viewport * 0.25, viewport - gaps) * zoom) / Math.max(1, total);
  let x = 0;
  const segments = times.map((item) => {
    const width = Math.max(0, item.end - item.start) * scale;
    const segment = { ...item, x, width };
    x += width + qaGap;
    return segment;
  });
  return { segments, scale, width: Math.max(viewport, x - (times.length ? qaGap : 0)) };
}
/** Preserve a QA-local position, including fixed-gap positions, between two zoom levels. */
export function mapTimelinePosition(x: number, from: TimelineLayout, to: TimelineLayout): number {
  for (let i = 0; i < from.segments.length; i++) {
    const item = from.segments[i]!,
      target = to.segments[i]!;
    if (x <= item.x + item.width) return target.x + Math.max(0, x - item.x) * (item.width ? target.width / item.width : 0);
    const next = from.segments[i + 1];
    if (next && x < next.x) return target.x + target.width + (x - item.x - item.width);
  }
  return to.width;
}
export function wheelIntent(dx: number, dy: number, mode: number, viewport: number) {
  const unit = mode === 1 ? 16 : mode === 2 ? viewport : 1;
  return Math.abs(dx) > Math.abs(dy) ? { pan: dx * unit, zoom: 0 } : { pan: 0, zoom: dy * unit };
}
function place(node: HTMLElement, x: number, width: number) {
  node.style.left = `${x}px`;
  node.style.width = `${Math.max(0, width)}px`;
}
/** True durations are never widened to fit a label. Tiny nodes remain focusable; zoom reveals them. */
export function renderSequence(container: HTMLElement, options: TimelineOptions) {
  const left = container.scrollLeft,
    top = container.scrollTop;
  const times = timedTraces(options.traces);
  container.replaceChildren();
  if (!times.length) {
    const empty = el('div', 'graph-empty');
    empty.append(el('div', 'empty-symbol', '⌁'), el('h2', '', '对话背后的运行，在这里展开'), el('p', '', '消息 → Execution → Operation → Attempt'), el('p', 'subtle', '真实时间、调用层级，以及每次运行留下的证据。'));
    container.append(empty);
    return undefined;
  }
  const layout = layoutTimeline(times, Math.max(1, container.clientWidth - laneWidth), options.zoom);
  const plotWidth = layout.width;
  const sheet = el('div', 'timeline-sheet');
  sheet.style.width = `${plotWidth + laneWidth}px`;
  const visible = layout.segments;
  const compact = container.clientHeight < 480;
  const qaHeight = compact ? 48 : 58,
    rowHeight = compact ? 64 : 72,
    step = compact ? 56 : 62;
  sheet.classList.toggle('compact', compact);
  sheet.style.setProperty('--qa-height', `${qaHeight}px`);
  const row = (name: string, subtitle: string, cls: string, height: number) => {
    const r = el('div', `timeline-row ${cls}`);
    r.style.height = `${height}px`;
    const label = el('div', 'lane-label');
    label.append(el('strong', '', name));
    if (subtitle) label.append(el('small', '', subtitle));
    const content = el('div', 'lane-content');
    content.style.width = `${plotWidth}px`;
    r.append(label, content);
    sheet.append(r);
    return content;
  };
  const qa = row('问答', `${times.length} 轮交流`, 'qa-row', qaHeight);
  const messages = row('消息', '被选次数', 'messages-row', compact ? 80 : 120);
  const e = row('执行', '', 'execution-row', rowHeight);
  const allCalls = visible.flatMap((segment) => segment.trace.callSequence!.calls.map((call) => ({ call, trace: segment.trace, base: segment.base, segment })));
  const operationDepth = (call: CallSpan, trace: Trace): number => {
    let depth = 0,
      current = call;
    const seen = new Set<string>();
    while (current.parentId && current.parentId !== trace.id && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = trace.callSequence!.calls.find((c) => c.id === current.parentId);
      if (!parent) break;
      depth++;
      current = parent;
    }
    return depth;
  };
  const depths = allCalls.filter((c) => c.call.recordType === 'operation').map((c) => operationDepth(c.call, c.trace));
  const operationRows = Math.max(1, ...depths.map((d) => d + 1));
  const o = row('操作', '', 'operation-row', rowHeight + (operationRows - 1) * step);
  // Overlapping attempts occupy sublanes inside A; they are not extra execution levels.
  const attemptLanes = new Map<string, number>(),
    laneEnds: number[] = [];
  for (const item of allCalls.filter((c) => c.call.recordType === 'attempt').sort((a, b) => a.base + a.call.offsetMs - b.base - b.call.offsetMs)) {
    const start = item.base + item.call.offsetMs;
    let lane = laneEnds.findIndex((end) => end <= start);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = start + (item.call.durationMs ?? item.trace.durationMs - item.call.offsetMs);
    attemptLanes.set(item.call.id, lane);
  }
  const a = row('意图', '', 'attempt-row', rowHeight + Math.max(0, laneEnds.length - 1) * step);
  const lanes = { execution: e, operation: o, attempt: a };
  for (const content of [messages, e, o, a]) {
    for (const item of visible) {
      for (const x of [item.x, item.x + item.width]) {
        const line = el('i', 'grid-line');
        line.style.left = `${x}px`;
        content.append(line);
      }
    }
  }
  const heatMax = Math.max(1, ...options.observation.messages.map((m) => m.count));
  const selectedIndexes = new Set(options.observation.executions.find((item) => item.id === options.selectedExecution)?.selections.flatMap((s) => s.indexes ?? []) ?? []);
  for (const item of visible) {
    const n = visible.indexOf(item) + 1,
      trace = item.trace;
    const observation = options.observation.executions.find((exe) => exe.id === trace.id);
    const title = el('button', `qa-marker${trace.id === options.selectedExecution ? ' selected' : ''}`);
    const heading = el('span', 'node-content');
    heading.append(el('span', 'qa-name', `QA ${String(n).padStart(2, '0')} · ${duration(item.end - item.start)}`), el('small', 'qa-start', `${new Date(item.start).toLocaleTimeString()} · +${duration(item.start - times[0]!.start)}`));
    title.append(heading);
    title.setAttribute('aria-label', `QA ${n} · 开始 ${new Date(item.start).toLocaleTimeString()} · 相对首轮 +${duration(item.start - times[0]!.start)} · 耗时 ${duration(item.end - item.start)}`);
    title.onclick = () => options.select(trace);
    place(title, item.x, item.width);
    qa.append(title);
    const inputIndex = observation?.inputIndex;
    const responseIndex = observation?.response?.index;
    const input = options.observation.messages.find((m) => m.index === inputIndex);
    const response = options.observation.messages.find((m) => m.index === responseIndex);
    const generated = trace.nodes.find((n) => n.operation === 'answer' && n.status === 'passed')?.output as { content?: string } | undefined;
    const parts = [
      { role: '用户', index: inputIndex, count: input?.count ?? 0, content: input?.message.content ?? (trace.facts.execution.value.input as { content?: string }).content },
      { role: '助手', index: responseIndex, count: response?.count ?? 0, content: observation?.response?.content ?? generated?.content },
    ];
    parts.forEach((part, half) => {
      const cell = el('button', `message-block${part.content === undefined ? ' absent' : ''}${part.index !== undefined && selectedIndexes.has(part.index) ? ' chosen' : ''}`);

      const content = el('span', 'node-content');
      const meta = el('span', 'node-meta');
      meta.append(el('span', 'block-meta', `${part.role} · ${part.count} 次`));
      if (part.index !== undefined && selectedIndexes.has(part.index)) meta.append(tag('chosen', '已选'));
      const heat = el('span', 'message-heat');
      heat.setAttribute('aria-hidden', 'true');
      const fill = el('i');
      fill.style.width = `${(part.count / heatMax) * 100}%`;
      heat.append(fill);
      content.append(meta, el('span', 'message-excerpt', part.content ?? '尚无回答'), heat);
      cell.append(content);
      cell.setAttribute('aria-label', `QA ${n} ${part.role}详情`);
      cell.onclick = () => options.select(trace);
      place(cell, item.x + (half * item.width) / 2, item.width / 2);
      messages.append(cell);
    });
  }
  for (const { call, trace, base, segment } of allCalls) {
    const start = base + call.offsetMs,
      length = Math.max(0, call.durationMs ?? trace.durationMs - call.offsetMs);
    const node = el('button', `call-block ${call.recordType} ${call.status}${options.selectedCall === call.id ? ' selected' : ''}`);
    node.dataset.call = call.id;
    node.dataset.execution = trace.id;
    const depth = call.recordType === 'operation' ? operationDepth(call, trace) : call.recordType === 'attempt' ? (attemptLanes.get(call.id) ?? 0) : 0;
    node.style.top = `${8 + depth * step}px`;
    place(node, segment.x + (start - segment.start) * layout.scale, length * layout.scale);
    const changes = options.memories.items.flatMap((m) => m.records).filter((r) => r.executionId === trace.id && (call.recordType === 'execution' || (call.operation?.endsWith('.applyMemory') && r.operationId === call.parentId)));
    const content = el('span', 'node-content');
    const heading = el('span', 'node-heading');
    heading.append(el('strong', '', call.label));
    if (call.status !== 'passed') heading.append(tag(call.status, call.status === 'failed' ? '失败' : '运行中'));
    const meta = el('span', 'node-meta');
    meta.append(el('span', 'block-meta', `${duration(length)}${changes.length ? ` · 记忆 ${changes.length}` : ''}`));
    if (options.selectedCall === call.id) meta.append(tag('selected', '查看中'));
    content.append(heading, meta);
    node.append(content);
    node.setAttribute('aria-label', `${call.recordType} ${call.label} ${duration(length)} ${call.status}`);
    node.onclick = () => options.select(trace, call);
    lanes[call.recordType].append(node);
  }
  container.append(sheet);
  container.scrollLeft = left;
  container.scrollTop = top;
  return layout;
}

/** Equal-width navigation summaries, projected from existing messages and execution records. */
export class QAOverview {
  private layout?: TimelineLayout;
  constructor(
    private readonly root: HTMLElement,
    private readonly diagram: HTMLElement,
    private readonly select: (id: string) => void,
  ) {}

  update(layout: TimelineLayout | undefined, observation: ExecutionObservation, memories: MemoryObservation, selectedId: string) {
    this.layout = layout;
    this.root.closest<HTMLElement>('.qa-overview')!.hidden = !layout;
    const scroll = this.root.scrollLeft;
    this.root.replaceChildren();
    if (!layout) return;
    layout.segments.forEach(({ trace }, index) => {
      const qa = observation.executions.find((item) => item.id === trace.id);
      const input = observation.messages.find((item) => item.index === qa?.inputIndex)?.message ?? (trace.facts.execution.value.input as { content?: string });
      const changes = memories.items.reduce((count, item) => count + item.records.filter((record) => record.executionId === trace.id).length, 0);
      const card = el('button', 'qa-summary');
      card.type = 'button';
      card.dataset.execution = trace.id;
      card.setAttribute('aria-label', `定位 QA ${index + 1}：${input?.content ?? '输入尚未记录'}`);
      if (trace.id === selectedId) card.setAttribute('aria-current', 'true');
      const heading = el('span', 'qa-summary-heading');
      heading.append(el('strong', '', `QA ${String(index + 1).padStart(2, '0')}`));
      const status = trace.status === 'failed' ? '失败' : trace.status === 'running' ? '运行中' : '完成';
      heading.append(el('span', `status-tag ${trace.status}`, status));
      card.append(heading, el('span', 'qa-summary-input', input?.content ?? '输入尚未记录'), el('span', 'qa-summary-meta', `${duration(trace.durationMs)}${changes ? ` · 记忆变更 ${changes}` : ''}`));
      card.onclick = () => this.select(trace.id);
      this.root.append(card);
    });
    this.root.scrollLeft = scroll;
    this.sync();
  }

  sync() {
    if (!this.layout) return;
    const left = this.diagram.scrollLeft;
    const right = left + Math.max(1, this.diagram.clientWidth - laneWidth);
    this.layout.segments.forEach((segment, index) => {
      this.root.children[index]?.classList.toggle('in-view', segment.x < right && segment.x + segment.width >= left);
    });
  }
}
