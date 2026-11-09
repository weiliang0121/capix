import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { readOutput, type CallableRecord, type ConversationCallDetail, type RecordedRelationChange } from '@weiliang0121/capix-protocol';

const relations: Record<RecordedRelationChange['kind'], string> = { attached: '已建立', returned: '子层返回', receiving: '接纳中', accepted: '已接纳', handled: '异常已处理', failed: '接纳失败' };

export function ConversationCalls({ detail }: { detail: ConversationCallDetail }) {
  const [selectedId, select] = useState<string>();
  const [collapsed, collapse] = useState<ReadonlySet<string>>(() => new Set());
  const all = useMemo(() => new Map([detail.root, ...detail.calls].map((call) => [call.id, call])), [detail]);
  const selected = (selectedId ? all.get(selectedId) : undefined) ?? detail.root;
  const rows = useMemo(() => {
    const rows: { call: CallableRecord; depth: number; children: number }[] = [];
    const pending = [{ call: detail.root, depth: 0 }];
    const visited = new Set<string>();
    for (let item = pending.pop(); item; item = pending.pop()) {
      if (visited.has(item.call.id)) continue;
      visited.add(item.call.id);
      const children = item.call.childIds.flatMap((id) => all.get(id) ?? []);
      rows.push({ ...item, children: children.length });
      if (!collapsed.has(item.call.id)) for (const child of [...children].reverse()) pending.push({ call: child, depth: Math.min(item.depth + 1, 20) });
    }
    return rows;
  }, [detail, all, collapsed]);
  const reception = useMemo(() => {
    const values = new Map<string, RecordedRelationChange>();
    for (const call of all.values()) for (const item of call.value.relationChanges) if (item.childId) values.set(item.childId, item.change);
    return values;
  }, [all]);
  const resources = detail.resources.filter((item) => item.parentId === selected.id);
  const transcripts = detail.transcripts.filter((item) => item.parentId === selected.id);
  const memories = detail.memories.filter((item) => item.parentId === selected.id);
  const boundaries = detail.boundaries.filter((item) => item.callId === selected.id);
  let output: unknown;
  try {
    output = readOutput(selected.value);
  } catch {
    output = { error: '这份记录的输出引用不完整' };
  }
  return (
    <section className="conversation-call-detail" aria-label="调用树与详情">
      <h3>调用结构</h3>
      {detail.truncated && <p className="conversation-problem">本次详情已达到容量限制，部分记录未显示。</p>}
      {detail.integrity === 'incomplete' && <p className="conversation-problem">来源不完整，不能据此判断全部调用均已结束。</p>}
      <div className="conversation-call-tree" aria-label="调用树">
        {rows.map(({ call, depth, children }) => (
          <div className="conversation-tree-row" key={call.id} style={{ paddingLeft: `${depth * 13}px` }}>
            <button
              className="conversation-tree-toggle"
              disabled={!children}
              aria-label={collapsed.has(call.id) ? '展开子调用' : '收起子调用'}
              aria-expanded={children ? !collapsed.has(call.id) : undefined}
              onClick={() =>
                collapse((before) => {
                  const next = new Set(before);
                  if (next.has(call.id)) next.delete(call.id);
                  else next.add(call.id);
                  return next;
                })
              }
            >
              {children ? collapsed.has(call.id) ? <ChevronRight size={14} /> : <ChevronDown size={14} /> : <span>·</span>}
            </button>
            <button className={`conversation-tree-call ${selected.id === call.id ? 'selected' : ''}`} onClick={() => select(call.id)}>
              <span>
                <small>{call.structureKind}</small>
                <strong>{call.label || call.name || '未命名调用'}</strong>
              </span>
              <span className="conversation-tree-state">
                <span>{statusLabel(call.status)}</span>
                {reception.has(call.id) && <small>{relations[reception.get(call.id)!.kind]}</small>}
              </span>
            </button>
          </div>
        ))}
      </div>
      <div className="conversation-inspection-card conversation-selected-call">
        <div className="conversation-card-heading">
          <h3>{selected.label || selected.name || '选中调用'}</h3>
          <span className="conversation-tag">{statusLabel(selected.status)}</span>
        </div>
        <p className="conversation-caption">
          {selected.structureKind} · {selected.contextId}
        </p>
        <details open>
          <summary>输入与最终输出摘要</summary>
          <pre>{json({ input: selected.value.input, ...(output === undefined ? {} : { output }), ...(selected.value.error ? { error: selected.value.error } : {}) })}</pre>
        </details>
        <details>
          <summary>子调用交接 · {selected.value.relationChanges.length}</summary>
          {selected.value.relationChanges.map((item, index) => (
            <div className="conversation-fact" key={index}>
              <strong>{relations[item.change.kind]}</strong>
              <small> {item.childId ? all.get(item.childId)?.name || item.childId : item.identity.childContextId}</small>
              <pre>{json(item.change)}</pre>
            </div>
          ))}
        </details>
        <details>
          <summary>资源操作 · {resources.length}</summary>
          {resources.map((item) => (
            <div className="conversation-fact" key={item.id}>
              <strong>{item.access}</strong>
              <small>
                {' '}
                · {item.phase} · #{item.sequence}
              </small>
              <pre>{json(item.value)}</pre>
            </div>
          ))}
        </details>
        <details>
          <summary>内容变更 · {transcripts.length + memories.length}</summary>
          {[...transcripts, ...memories].map((item) => (
            <div className="conversation-fact" key={item.id}>
              <pre>{json(item)}</pre>
            </div>
          ))}
        </details>
        <details>
          <summary>执行过程 · {selected.value.processes.length}</summary>
          <pre>{json(selected.value.processes)}</pre>
        </details>
        <details>
          <summary>调用边界 · {boundaries.length}</summary>
          <pre>{json(boundaries)}</pre>
        </details>
      </div>
    </section>
  );
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? '无返回值';
}

export function statusLabel(status: 'running' | 'succeeded' | 'failed'): string {
  return { running: '运行中', succeeded: '完成', failed: '失败' }[status];
}
