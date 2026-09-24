import type { ExecutionObservation } from '../../shared/observation/execution.js';
import type { MemoryObservation } from '../../shared/observation/memory.js';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

/** Three aligned lanes; columns belong to actual executions, including failed executions. */
export class SelectionView {
  private data: ExecutionObservation = { messages: [], executions: [] };
  private memories: MemoryObservation = { items: [] };
  private executionId = '';
  constructor(
    private readonly root: HTMLElement,
    private readonly select: (id: string) => void,
  ) {}

  update(data: ExecutionObservation) {
    this.data = data;
    this.render();
  }
  updateMemory(data: MemoryObservation) {
    this.memories = data;
    this.render();
  }
  selectExecution(id: string) {
    this.executionId = id;
    this.render();
    const rail = this.root.querySelector<HTMLElement>('.qa-rail');
    const column = rail?.querySelector<HTMLElement>('.qa-column.active');
    if (rail && column) {
      if (column.offsetLeft < rail.scrollLeft) rail.scrollLeft = column.offsetLeft;
      else if (column.offsetLeft + column.offsetWidth > rail.scrollLeft + rail.clientWidth) rail.scrollLeft = column.offsetLeft + column.offsetWidth - rail.clientWidth;
    }
  }

  private render() {
    const scrollLeft = this.root.querySelector('.qa-rail')?.scrollLeft ?? 0;
    const { messages, executions } = this.data;
    const execution = executions.find((item) => item.id === this.executionId);
    const selectedIndexes = new Set(execution?.selections.flatMap((item) => item.indexes ?? []) ?? []);
    const maximum = Math.max(0, ...messages.map((item) => item.count));
    const header = element('div', 'section-title');
    header.append(element('h2', '', '交流次序'), element('span', 'pill', `${executions.length} 轮 · ${messages.length} 条消息`));
    const legend = element('div', 'heat-legend');
    legend.append(element('span', '', '累计被选次数'), element('span', 'heat-gradient'), element('span', '', `0 → ${maximum}`), element('span', 'legend-outline', '金框：本轮选中的历史'));
    const lanes = element('div', 'qa-lanes');
    const labels = element('div', 'qa-lane-labels');
    labels.append(element('span', '', 'QA'), element('span', '', '用户'), element('span', '', '助手'), element('span', '', '记忆体'));
    const rail = element('div', 'qa-rail');
    rail.setAttribute('aria-label', '按 QA 排列的用户、助手和记忆体');
    for (let i = 0; i < executions.length; i++) {
      const item = executions[i]!;
      const column = element('div', `qa-column${item.id === this.executionId ? ' active' : ''}`);
      column.dataset.execution = item.id;
      const title = element('button', 'qa-column-title', `QA ${String(i + 1).padStart(2, '0')}${item.status === 'failed' ? ' · 失败' : item.status === 'running' ? ' · 进行中' : ''}`);
      title.setAttribute('aria-pressed', String(item.id === this.executionId));
      title.addEventListener('click', () => this.select(item.id));
      const input = messages.find((message) => message.index === item.inputIndex);
      const response = messages.find((message) => message.index === item.response?.index);
      column.append(title, this.messageCell(input?.message.content, input?.index, input?.count, '用户', item.id, maximum, selectedIndexes), this.messageCell(item.response?.content, response?.index, response?.count, '助手', item.id, maximum, selectedIndexes));
      const changes = this.memories.items.flatMap((memory) => memory.records).filter((record) => record.executionId === item.id);
      const memory = element('button', 'qa-memory-cell');
      memory.append(element('strong', '', changes.length ? `${changes.length} 条变化` : item.memoryStatus === 'succeeded' ? '无变化' : item.memoryStatus === 'failed' ? '提取失败' : item.memoryStatus === 'running' ? '提取中' : '未提取'));
      memory.append(element('span', '', changes.length ? changes.map((record) => `${record.value.action === 'create' ? '新建' : '更新'} · ${record.value.result.topic}`).join(' / ') : '—'));
      memory.setAttribute('aria-label', `QA ${i + 1} 记忆体 · ${memory.textContent}`);
      memory.addEventListener('click', () => this.select(item.id));
      column.append(memory);
      rail.append(column);
    }
    if (!executions.length) rail.append(element('p', 'observation-empty', '完成一次输入后，这里将按 QA 展开三条轨道。'));
    lanes.append(labels, rail);
    const note = element('p', 'panel-note heat-footnote', '左右滚动查看各轮。颜色与次数为全部执行累计；点击任意格，同步切换 QA 详情、记忆记录和调用时序。');
    const detail = element('section', 'qa-detail');
    const pair = element('div', 'qa-message-pair');
    if (execution) {
      detail.append(element('h2', '', `QA ${String(executions.indexOf(execution) + 1).padStart(2, '0')} · 交流详情`));
      const input = messages.find((message) => message.index === execution.inputIndex);
      pair.append(this.detailBlock('用户输入', input?.message.content ?? '输入记录不可用。', input?.index), this.detailBlock('助手回答', execution.response?.content ?? (execution.status === 'running' ? '尚未产生回答。' : '本轮未记录到成功生成的回答。'), execution.response?.index));
      detail.append(pair);
      for (const call of execution.selections) detail.append(element('p', 'panel-note', call.indexes ? `历史选择顺序：${call.indexes.length ? call.indexes.map((index) => `[${index}]`).join(' → ') : '未选择历史'}` : '筛选尚无已接纳结果。'));
    } else detail.append(element('p', 'panel-note', '选中一轮，查看用户输入与助手回答。'));
    this.root.replaceChildren(header, legend, lanes, note, detail);
    rail.scrollLeft = scrollLeft;
  }
  private messageCell(content: string | undefined, index: number | undefined, count: number | undefined, role: string, executionId: string, maximum: number, selected: Set<number>) {
    const cell = element('button', `heat-message${index !== undefined && selected.has(index) ? ' chosen' : ''}${content === undefined ? ' absent' : ''}`);
    const strength = maximum ? (count ?? 0) / maximum : 0;
    cell.style.setProperty('--heat', count ? `hsl(155 28% ${97 - strength * 12}%)` : '#fafbf9');
    cell.style.setProperty('--heat-bar', count ? `hsl(155 31% ${72 - strength * 40}%)` : '#e5eae5');
    const top = element('span', 'heat-message-meta');
    top.append(element('span', '', index === undefined ? role : `[${index}] · ${role}`), element('strong', '', count === undefined ? '—' : `${count} 次`));
    cell.append(top, element('span', 'heat-message-preview', content ?? '未产生回答'));
    cell.setAttribute('aria-label', `${role}${index === undefined ? '' : ` [${index}]`} · ${content ?? '未产生回答'}`);
    cell.addEventListener('click', () => this.select(executionId));
    return cell;
  }
  private detailBlock(title: string, content: string, index?: number) {
    const block = element('article', 'qa-message-block');
    block.append(element('h3', '', `${title}${index === undefined ? '' : ` · [${index}]`}`), element('p', '', content));
    return block;
  }
}
