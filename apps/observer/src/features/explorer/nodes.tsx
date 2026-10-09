import type { ExecutionSummary } from '@capix-observer/protocol';
import type { RoundView } from '../../state/data';
import type { CallGeometry } from './layout';
import { formatDuration } from './layout';
import { Badge } from '../../components/ui/badge';
export const qaName = (index: number) => `QA ${String(index + 1).padStart(2, '0')}`;
export const roleNames = { user: '用户', assistant: '助手' };
export const statusNames = { running: '运行中', succeeded: '完成', failed: '失败' };
export const laneNames = { execution: '执行', operation: '操作', attempt: '意图' };
export const laneHeight = 76;

export function Status({ status }: { status: ExecutionSummary['status'] }) {
  return (
    <Badge variant="secondary" className={`explorer-status explorer-status-${status}`}>
      {statusNames[status]}
    </Badge>
  );
}

export function Highlight({ text, search }: { text: string; search: string }) {
  const term = search.trim();
  const index = term ? text.toLocaleLowerCase().indexOf(term.toLocaleLowerCase()) : -1;
  if (index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + term.length)}</mark>
      {text.slice(index + term.length)}
    </>
  );
}

export function ContextSummary({ execution, onInspect }: { execution: RoundView; onInspect: () => void }) {
  const { inputCount, selectedCount, selectedMessages, selectionComplete } = execution.context;
  return (
    <button type="button" className="explorer-context" onClick={onInspect} aria-label={`查看本轮上下文：选中 ${selectedCount} 条历史，${execution.availableMemoryIds.length} 个可见记忆，${execution.memoryChanges.length} 项记忆变化`}>
      <div className="explorer-context-message">
        <span>
          输入 #{execution.inputIndex} · 累计被选 {inputCount} 次
        </span>
        <p>{execution.inputContent}</p>
      </div>
      <div className="explorer-context-facts">
        <span>
          历史 <b>{selectionComplete ? `${selectedCount} 条选中` : '尚未选定'}</b>
        </span>
        <span>
          记忆 <b>{execution.availableMemoryIds.length} 个可见</b>
        </span>
        <span>
          回答 <b>{execution.response ? (execution.response.content === undefined ? '尚未加载' : `${execution.response.content.length} 字符`) : '尚无回答'}</b>
        </span>
        <span>
          变化 <b>{execution.memoryChanges.length} 项</b>
        </span>
      </div>
      {selectedMessages.length > 0 && (
        <div className="explorer-evidence">
          <span className="explorer-evidence-label">选中历史 · 按选择优先级</span>
          {selectedMessages.slice(0, 3).map(({ index, entry }) => (
            <div key={index} className="explorer-evidence-item">
              <span className="explorer-evidence-meta">
                #{index} · {entry ? roleNames[entry.message.role] : '消息'} · 被选 {entry?.count ?? 0} 次
              </span>
              <span className="explorer-evidence-text">{entry?.message.content ?? '原文不可用'}</span>
            </div>
          ))}
        </div>
      )}
      <div className="explorer-context-links">
        <span>{selectedCount ? `查看全部 ${selectedCount} 条选中原文与记录` : '查看消息、上下文与记录'}</span>
        <span aria-hidden="true">↗</span>
      </div>
    </button>
  );
}

export function InvocationNode({ item, columnWidth, onInspect }: { item: CallGeometry; columnWidth: number; onInspect: () => void }) {
  const { call } = item;
  const width = item.width * columnWidth;
  const compact = width < 64;
  const label = call.recordType === 'execution' ? '本轮执行' : call.label;
  return (
    <button type="button" className={`explorer-node explorer-family-${item.family}${compact ? ' explorer-node-compact' : ''}${call.status === 'running' ? ' explorer-node-running' : ''}`} style={{ left: `${item.left * 100}%`, width: `${item.width * 100}%`, top: item.lane * laneHeight + 10 }} aria-label={`${laneNames[call.recordType]}：${label}，${statusNames[call.status]}，${formatDuration(call.durationMs)}。查看调用详情`} onClick={onInspect}>
      {!compact && (
        <>
          <span className="explorer-node-heading">
            <strong>{label}</strong>
            {call.status !== 'succeeded' && <Status status={call.status} />}
          </span>
          <span className="explorer-node-meta">{formatDuration(call.durationMs)}</span>
        </>
      )}
    </button>
  );
}
