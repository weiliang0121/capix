import type { MemoryObservation } from '../../shared/observation/memory.js';
import type { MemoryRecord } from '../../shared/records/memory.js';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

export class MemoryView {
  private data: MemoryObservation = { items: [] };
  private executionId = '';
  constructor(private readonly root: HTMLElement) {}

  update(observation: MemoryObservation) {
    this.data = observation;
    this.render();
  }
  selectExecution(id: string) {
    this.executionId = id;
    this.render();
  }
  private render() {
    const records = this.data.items.flatMap((memory) => memory.records).filter((record) => record.executionId === this.executionId);
    const header = element('div', 'section-title');
    header.append(element('h2', '', this.executionId ? '本轮记忆体' : '当前记忆总览'), element('span', 'pill', this.executionId ? `${records.length} 条变化` : `${this.data.items.length} 个当前理解`));
    const note = element('p', 'panel-note', this.executionId ? '展示本轮登记的变化及当时的内容快照。' : '跨轮保留的当前理解 · 记忆暂不参与回答');
    const grid = element('div', 'memory-grid');
    if (this.executionId) {
      for (const record of records) grid.append(this.changeCard(record));
    } else {
      for (const memory of [...this.data.items].reverse()) {
        const card = element('article', 'memory-card');
        const top = element('div', 'card-meta');
        top.append(element('span', 'card-tag', '当前理解'), element('span', '', `${memory.records.length} 次变化 · ${memory.id.slice(0, 8)}`));
        card.append(top, element('h3', 'card-title', memory.topic), element('p', 'card-content', memory.content));
        const evidence = element('details', 'card-disclosure');
        evidence.append(element('summary', '', `原文依据 · ${memory.sources.length} 条`));
        for (const source of memory.sources) evidence.append(element('blockquote', 'memory-source', `[${source.index}] ${source.message.role === 'user' ? '用户' : '助手'}\n${source.message.content}`));
        const history = element('details', 'card-disclosure');
        history.append(element('summary', '', `变化记录 · ${memory.records.length} 条`));
        for (const record of [...memory.records].reverse()) history.append(this.recordDetail(record));
        card.append(evidence, history);
        grid.append(card);
      }
    }
    if (!grid.childElementCount) grid.append(element('p', 'observation-empty', this.executionId ? '本轮没有已登记的记忆变化。提取可能返回空结果，或未成功完成。' : '还没有记忆体。完成一次交流后，可以在这里查看形成的理解。'));
    this.root.replaceChildren(header, note, grid);
  }
  private changeCard(record: MemoryRecord) {
    const card = element('article', 'memory-card');
    const top = element('div', 'card-meta');
    top.append(element('span', `card-tag ${record.value.action}`, record.value.action === 'create' ? '新建' : '更新'), element('span', '', record.memoryId.slice(0, 8)));
    card.append(top, element('h3', 'card-title', record.value.result.topic), element('p', 'change-description', record.value.change), element('h4', 'card-caption', '当时的理解'), element('p', 'card-content', record.value.result.content));
    card.append(this.recordDetail(record));
    return card;
  }
  private recordDetail(record: MemoryRecord) {
    const entry = element('details', 'card-disclosure record-detail');
    entry.append(element('summary', '', this.executionId ? '查看依据与记录' : `${record.value.action === 'create' ? '新建' : '更新'} · ${record.value.change}`));
    if (!this.executionId) entry.append(element('p', 'card-content', record.value.result.content));
    entry.append(element('p', 'record-evidence', `本次依据 ${record.value.sourceIndexes.map((index) => `[${index}]`).join(' ')}\n完整内容依据 ${record.value.result.sourceIndexes.map((index) => `[${index}]`).join(' ')}`));
    const ids = element('dl', 'record-identities');
    for (const [label, id] of [
      ['记忆', record.memoryId],
      ['记录', record.id],
      ['执行', record.executionId],
      ['操作', record.operationId],
    ])
      ids.append(element('dt', '', label), element('dd', '', id));
    entry.append(ids);
    return entry;
  }
}
