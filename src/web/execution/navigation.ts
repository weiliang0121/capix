import type { SelectionObservation } from '../../shared/observation/selection.js';

/** One UI selection shared by memory changes and history selection. */
export class ExecutionNavigation {
  private data: SelectionObservation = { messages: [], executions: [] };
  private executionId = '';
  constructor(
    private readonly root: HTMLElement,
    private readonly select: (id: string) => void,
  ) {}

  update(data: SelectionObservation) {
    this.data = data;
    this.render();
  }
  selectExecution(id: string) {
    this.executionId = id;
    this.render();
  }
  private render() {
    const { messages, executions } = this.data;
    const index = executions.findIndex((execution) => execution.id === this.executionId);
    const execution = executions[index];
    const label = document.createElement('label');
    label.textContent = '按 QA 观察运行';
    const select = document.createElement('select');
    select.setAttribute('aria-label', '切换 QA 执行');
    select.add(new Option('全部 · 当前记忆总览', ''));
    executions.forEach((item, i) => select.add(new Option(`QA ${String(i + 1).padStart(2, '0')} · ${messages.find((message) => message.index === item.inputIndex)?.message.content.slice(0, 52) ?? item.id}`, item.id)));
    select.value = execution?.id ?? '';
    select.addEventListener('change', () => {
      this.select(select.value);
      this.root.querySelector('select')?.focus({ preventScroll: true });
    });
    label.append(select);
    const controls = document.createElement('div');
    controls.className = 'qa-switch';
    const previous = this.button('←', '上一轮 QA', () => this.select(executions[index - 1]!.id));
    previous.disabled = index <= 0;
    const next = this.button('→', '下一轮 QA', () => this.select(executions[index + 1]!.id));
    next.disabled = index + 1 >= executions.length;
    const all = this.button('全部', '查看全部', () => this.select(''));
    all.setAttribute('aria-pressed', String(!execution));
    controls.append(previous, label, next, all);
    const caption = document.createElement('p');
    caption.className = 'qa-caption';
    caption.textContent = execution ? (messages.find((message) => message.index === execution.inputIndex)?.message.content ?? '') : '在每轮交流之间，查看理解如何积累、哪些历史被选中。';
    const meta = document.createElement('div');
    meta.className = 'qa-meta';
    const status = { running: '进行中', succeeded: '已完成', failed: '失败' };
    meta.textContent = execution ? `QA ${String(index + 1).padStart(2, '0')} / ${executions.length} · ${status[execution.status]} · ${new Date(execution.startedAt).toLocaleTimeString()} · ${execution.id.slice(0, 8)}` : `${executions.length} 次执行 · ${messages.length} 条消息`;
    this.root.replaceChildren(controls, caption, meta);
  }
  private button(text: string, label: string, click: () => void) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', click);
    return button;
  }
}
