import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { InvocationSummary } from '@capix-observer/protocol';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import type { ExplorerProps } from './types';
import { axisWidth, defaultColumnWidth, densityScroll, formatDuration, layoutColumns, layoutInvocations, maximumColumnWidth, minimumColumnWidth, visibleColumns, wheelIntent } from './layout';
import './explorer.css';

import { qaName, roleNames, statusNames, laneNames, laneHeight, Status, Highlight, ContextSummary, InvocationNode } from './nodes';

export function RuntimeExplorer({ rounds: executions, matches, selectedId, onSelect, onInspect, search, setSearch, matchCursor, setMatchCursor, columnWidth, setColumnWidth }: ExplorerProps) {
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  const viewport = useRef<HTMLDivElement>(null);
  const navigation = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<number | undefined>(undefined);
  const ids = useMemo(() => executions.map((execution) => execution.id), [executions]);
  const layout = useMemo(() => layoutColumns(ids, columnWidth), [ids, columnWidth]);
  const invocations = useMemo(() => executions.map(layoutInvocations), [executions]);
  const matchById = useMemo(() => new Map(matches.map((match) => [match.executionId, match])), [matches]);
  const operationLanes = Math.max(1, ...invocations.map((item) => item.operationLanes));
  const attemptLanes = Math.max(1, ...invocations.map((item) => item.attemptLanes));
  const densityName = columnWidth < 380 ? '紧凑' : columnWidth > 640 ? '展开' : '标准';

  const revealNavigation = useCallback((id: string) => {
    const container = navigation.current;
    const item = container?.querySelector<HTMLElement>(`[data-execution-id="${CSS.escape(id)}"]`);
    if (!container || !item) return;
    if (item.offsetLeft < container.scrollLeft) container.scrollLeft = item.offsetLeft;
    else if (item.offsetLeft + item.offsetWidth > container.scrollLeft + container.clientWidth) container.scrollLeft = item.offsetLeft + item.offsetWidth - container.clientWidth;
  }, []);

  const updateVisible = useCallback(
    (syncNavigation = false) => {
      const container = viewport.current;
      if (!container) return;
      const next = visibleColumns(layout, container.scrollLeft, Math.max(0, container.clientWidth - axisWidth));
      setVisibleIds((previous) => (previous.join('|') === next.join('|') ? previous : next));
      if (syncNavigation && next.length) revealNavigation(next.includes(selectedId) ? selectedId : next[0]!);
    },
    [layout, revealNavigation, selectedId],
  );

  const locate = useCallback(
    (id: string) => {
      const column = layout.columns.find((item) => item.id === id);
      const container = viewport.current;
      if (container && column) container.scrollLeft = Math.max(0, column.x - Math.max(0, container.clientWidth - axisWidth - column.width) / 2);
      revealNavigation(id);
      onSelect(id);
      updateVisible();
    },
    [layout, onSelect, revealNavigation, updateVisible],
  );

  const changeDensity = useCallback(
    (width: number, anchor?: number) => {
      const container = viewport.current;
      const next = layoutColumns(ids, width);
      if (next.columnWidth === layout.columnWidth) return;
      if (container) {
        const visibleWidth = Math.max(0, container.clientWidth - axisWidth);
        pendingScroll.current = densityScroll(layout, next, container.scrollLeft, anchor ?? visibleWidth / 2, visibleWidth);
      }
      setColumnWidth(next.columnWidth);
    },
    [ids, layout, setColumnWidth],
  );

  useLayoutEffect(() => {
    if (viewport.current && pendingScroll.current !== undefined) {
      viewport.current.scrollLeft = pendingScroll.current;
      pendingScroll.current = undefined;
    }
    updateVisible();
  }, [layout, updateVisible]);

  useEffect(() => {
    const container = viewport.current;
    if (!container) return;
    const observer = new ResizeObserver(() => updateVisible());
    observer.observe(container);
    return () => observer.disconnect();
  }, [updateVisible]);

  // Passive React wheel listeners cannot prevent page scrolling while changing graph density.
  useEffect(() => {
    const container = viewport.current;
    if (!container) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) return;
      const intent = wheelIntent(event.deltaX, event.deltaY, event.deltaMode, container.clientWidth, event.shiftKey);
      if (!intent.pan && !intent.density) return;
      event.preventDefault();
      if (intent.pan) container.scrollLeft += intent.pan;
      else changeDensity(layout.columnWidth * Math.exp(-intent.density * 0.002), Math.max(0, event.clientX - container.getBoundingClientRect().left - axisWidth));
    };
    container.addEventListener('wheel', wheel, { passive: false });
    return () => container.removeEventListener('wheel', wheel);
  }, [changeDensity, layout.columnWidth]);

  const previousSelection = useRef('');
  useEffect(() => {
    if (!selectedId || previousSelection.current === selectedId || !ids.includes(selectedId)) return;
    previousSelection.current = selectedId;
    locate(selectedId);
  }, [ids, locate, selectedId]);

  const goToMatch = (direction: 1 | -1) => {
    if (!matches.length) return;
    const next = matchCursor < 0 ? (direction === 1 ? 0 : matches.length - 1) : (matchCursor + direction + matches.length) % matches.length;
    setMatchCursor(next);
    locate(matches[next]!.executionId);
  };

  const row = (type: InvocationSummary['recordType'], lanes: number) => (
    <div className={`explorer-row explorer-invocation-row explorer-row-${type}`} style={{ height: lanes * laneHeight }}>
      <div className="explorer-axis">{laneNames[type]}</div>
      <div className="explorer-row-content" style={{ width: layout.width }}>
        {layout.columns.map((column, index) => (
          <div key={column.id} className="explorer-call-column" style={{ left: column.x, width: column.width }}>
            {invocations[index]?.calls
              .filter((item) => item.call.recordType === type)
              .map((item) => (
                <InvocationNode key={item.call.id} item={item} columnWidth={column.width} onInspect={() => onInspect(column.id, item.call.id)} />
              ))}
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <section className="explorer-root" aria-label="运行图谱" style={{ '--explorer-axis-width': `${axisWidth}px` } as CSSProperties}>
      <div className="explorer-toolbar">
        <div className="explorer-search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d="m16 16 5 5" />
          </svg>
          <input
            type="search"
            aria-label="搜索问答全文"
            placeholder="搜索用户输入或助手回答…"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                goToMatch(event.shiftKey ? -1 : 1);
              }
            }}
          />
          {search.trim() && (
            <>
              <span className="explorer-search-count" role="status">
                {matches.length ? (matchCursor >= 0 ? `${matchCursor + 1} / ${matches.length}` : `${matches.length} 轮匹配`) : '无匹配'}
              </span>
              <Button variant="ghost" size="icon" className="explorer-small-control" aria-label="上一个匹配" disabled={!matches.length} onClick={() => goToMatch(-1)}>
                ↑
              </Button>
              <Button variant="ghost" size="icon" className="explorer-small-control" aria-label="下一个匹配" disabled={!matches.length} onClick={() => goToMatch(1)}>
                ↓
              </Button>
            </>
          )}
        </div>
        <div className="explorer-density">
          <span>密度</span>
          <Button variant="outline" size="icon" className="explorer-small-control" aria-label="显示更多问答" disabled={columnWidth <= minimumColumnWidth} onClick={() => changeDensity(columnWidth / 1.25)}>
            −
          </Button>
          <span className="explorer-density-name">{densityName}</span>
          <Button variant="outline" size="icon" className="explorer-small-control" aria-label="展开问答列" disabled={columnWidth >= maximumColumnWidth} onClick={() => changeDensity(columnWidth * 1.25)}>
            +
          </Button>
          <Button variant="ghost" size="sm" onClick={() => changeDensity(defaultColumnWidth)}>
            重置
          </Button>
        </div>
      </div>

      {executions.length ? (
        <>
          <div className="explorer-navigation-heading">
            <span>
              轮次导航 <b>{executions.length}</b>
            </span>
            <span>点击定位 · 浅底为可见范围</span>
          </div>
          <nav className="explorer-navigation" aria-label="问答轮次导航" ref={navigation}>
            {executions.map((execution, index) => {
              const match = matchById.get(execution.id);
              return (
                <button key={execution.id} type="button" className={`explorer-nav-card${selectedId === execution.id ? ' explorer-nav-current' : ''}${visibleIds.includes(execution.id) ? ' explorer-nav-visible' : ''}${match ? ' explorer-nav-match' : ''}`} data-execution-id={execution.id} aria-current={selectedId === execution.id ? 'true' : undefined} aria-label={`${qaName(index)}，${statusNames[execution.status]}，${execution.inputContent}`} onClick={() => locate(execution.id)}>
                  <div className="explorer-nav-heading">
                    <strong>{qaName(index)}</strong>
                    {selectedId === execution.id && execution.status === 'succeeded' ? (
                      <Badge variant="secondary" className="explorer-current-tag">
                        当前查看
                      </Badge>
                    ) : (
                      <Status status={execution.status} />
                    )}
                  </div>
                  <p>
                    {match ? (
                      <>
                        <span className="explorer-match-role">{roleNames[match.role]} · </span>
                        <Highlight text={match.snippet} search={search} />
                      </>
                    ) : (
                      execution.inputContent
                    )}
                  </p>
                  <div className="explorer-nav-meta">
                    <span>{formatDuration(execution.durationMs)}</span>
                    {execution.memoryChanges.length > 0 && <span>记忆变化 {execution.memoryChanges.length}</span>}
                  </div>
                </button>
              );
            })}
          </nav>
          <div className="explorer-legend">
            <div>
              <span className="explorer-family-key explorer-family-selection">选择</span>
              <span className="explorer-family-key explorer-family-answer">回答</span>
              <span className="explorer-family-key explorer-family-memory">记忆</span>
            </div>
            <span>轮内宽度表示耗时 · 点击节点查看记录</span>
          </div>
          <div className="explorer-viewport" ref={viewport} onScroll={() => updateVisible(true)} tabIndex={0} aria-label="执行图谱，纵向滚轮调整密度，横向滚轮平移">
            <div className="explorer-canvas" style={{ width: layout.width + axisWidth }}>
              <div className="explorer-row explorer-qa-row">
                <div className="explorer-axis">问答</div>
                <div className="explorer-row-content" style={{ width: layout.width }}>
                  {layout.columns.map((column, index) => (
                    <button type="button" key={column.id} className={`explorer-qa-header${selectedId === column.id ? ' explorer-qa-current' : ''}`} style={{ left: column.x, width: column.width }} onClick={() => onInspect(column.id)} aria-label={`查看 ${qaName(index)} 详情`}>
                      <strong>{qaName(index)}</strong>
                      <span>{new Date(executions[index]!.startedAt).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                      <span>{formatDuration(executions[index]!.durationMs)}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="explorer-row explorer-context-row">
                <div className="explorer-axis">上下文</div>
                <div className="explorer-row-content" style={{ width: layout.width }}>
                  {layout.columns.map((column, index) => (
                    <div className="explorer-context-column" key={column.id} style={{ left: column.x, width: column.width }}>
                      <ContextSummary execution={executions[index]!} onInspect={() => onInspect(column.id)} />
                    </div>
                  ))}
                </div>
              </div>
              {row('execution', 1)}
              {row('operation', operationLanes)}
              {row('attempt', attemptLanes)}
            </div>
          </div>
        </>
      ) : (
        <div className="explorer-empty">
          <div className="explorer-empty-glyph" aria-hidden="true">
            ◇
          </div>
          <h3>从一次对话开始</h3>
          <p>发送消息后，在这里查看上下文、执行和意图的关系。</p>
        </div>
      )}
    </section>
  );
}

export default RuntimeExplorer;
