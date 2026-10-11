import type { ExecutionSummary } from '@capix/protocol';
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
