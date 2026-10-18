import { archiveNotice } from '../../observation/status.js';
import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { RoundView } from '../../state/data.js';
import type { CallGraphModel } from '../../state/graph.js';
import { errorMessage } from '../../lib/errors.js';
import { formatDuration } from './layout.js';
import { qaName, Status } from './nodes.js';
import { CallGraph } from './CallGraph.js';
import { ElapsedCalls } from './ElapsedCalls.js';

export interface RoundGraphProps {
  round: RoundView;
  graph?: CallGraphModel;
  index: number;
  width: number;
  selected: boolean;
  mode: 'calls' | 'timing';
  expanded: ReadonlyMap<string, boolean>;
  toggle: (id: string, open: boolean) => void;
  inspect: (executionId: string, callId?: string) => void;
  load: (id: string, signal?: AbortSignal) => Promise<void>;
  measured: (id: string, height: number) => void;
}

export function RoundGraph({ round, graph, index, width, selected, mode, expanded, toggle, inspect, load, measured }: RoundGraphProps) {
  const element = useRef<HTMLElement>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const summaryOnly = !graph || graph.summaryOnly;
  useEffect(() => {
    if (!summaryOnly || mode !== 'calls') return;
    const controller = new AbortController();
    setError('');
    void load(round.id, controller.signal).catch((failure) => {
      if (!controller.signal.aborted) setError(errorMessage(failure));
    });
    return () => controller.abort();
  }, [round.id, summaryOnly, load, attempt, mode]);
  useEffect(() => {
    if (!element.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) measured(round.id, entry.target.getBoundingClientRect().height);
    });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [round.id, measured]);
  const inspectCall = (id: string) => inspect(round.id, id);
  return (
    <article ref={element} className={`round-graph${selected ? ' round-graph-selected' : ''}`} style={{ width }} aria-label={`${qaName(index)} 调用图`}>
      <header className="round-graph-heading">
        <button type="button" onClick={() => inspect(round.id)} aria-label={`查看 ${qaName(index)} 详情`}>
          <strong>{qaName(index)}</strong>
          <ArrowUpRight size={13} />
        </button>
        <Status status={round.status} />
        <span className="round-graph-total">{formatDuration(round.durationMs, round.status)}</span>
      </header>
      <button type="button" className="round-graph-context" onClick={() => inspect(round.id)} aria-label={`查看 ${qaName(index)} 的输入和上下文`}>
        <p>{round.inputContent}</p>
        <div>
          <span>历史 {round.context.selectionComplete ? `${round.context.selectedCount} 条纳入` : '待准备'}</span>
          <span>记忆 {round.availableMemoryIds.length} 个可见</span>
          <span>{round.response?.index !== undefined ? '回答已落实' : '暂无回答定位'}</span>
          {round.memoryChanges.length > 0 && <span>记忆变化 {round.memoryChanges.length} 项</span>}
        </div>
      </button>
      {round.archive && <p className="call-graph-note">{archiveNotice(round.archive)}</p>}
      {mode === 'calls' ? (
        <>
          {summaryOnly && (
            <div className="round-graph-loading" role="status">
              {error ? (
                <>
                  <span>关系详情暂不可用：{error}</span>
                  <button type="button" onClick={() => setAttempt((value) => value + 1)}>
                    重试
                  </button>
                </>
              ) : (
                '正在加载关系详情… 当前仅显示调用概览'
              )}
            </div>
          )}
          {graph && <CallGraph graph={graph} expanded={expanded} toggle={toggle} inspect={inspectCall} />}
        </>
      ) : (
        <ElapsedCalls round={round} width={width - 32} inspect={inspectCall} />
      )}
    </article>
  );
}
