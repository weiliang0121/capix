import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import type { ExplorerProps } from './types';
import { defaultColumnWidth, densityScroll, formatDuration, layoutColumns, maximumColumnWidth, minimumColumnWidth, visibleColumnWindow } from './layout';
import { qaName, roleNames, statusNames, Status, Highlight } from './nodes';
import { RoundGraph } from './RoundGraph';
import './explorer.css';

export function RuntimeExplorer({ rounds, graphs, loadExecution, matches, selectedId, onSelect, onInspect, search, setSearch, matchCursor, setMatchCursor, columnWidth, setColumnWidth }: ExplorerProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const navigation = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<number | undefined>(undefined);
  const scrollFrame = useRef<number | undefined>(undefined);
  const [view, setView] = useState({ left: 0, width: 0, height: 0 });
  const [mode, setMode] = useState<'calls' | 'timing'>('calls');
  const [expanded, setExpanded] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(new Map());
  const ids = useMemo(() => rounds.map((round) => round.id), [rounds]);
  const layout = useMemo(() => layoutColumns(ids, columnWidth), [ids, columnWidth]);
  const window = useMemo(() => visibleColumnWindow(layout, view.left, view.width), [layout, view.left, view.width]);
  const matchById = useMemo(() => new Map(matches.map((match) => [match.executionId, match])), [matches]);
  const densityName = columnWidth < 380 ? '紧凑' : columnWidth > 640 ? '展开' : '标准';

  const revealNavigation = useCallback((id: string) => {
    const container = navigation.current;
    const item = container?.querySelector<HTMLElement>(`[data-execution-id="${CSS.escape(id)}"]`);
    if (!container || !item) return;
    if (item.offsetLeft < container.scrollLeft) container.scrollLeft = item.offsetLeft;
    else if (item.offsetLeft + item.offsetWidth > container.scrollLeft + container.clientWidth) container.scrollLeft = item.offsetLeft + item.offsetWidth - container.clientWidth;
  }, []);

  const updateVisible = useCallback(() => {
    const container = viewport.current;
    if (!container) return;
    const next = { left: container.scrollLeft, width: container.clientWidth, height: container.clientHeight };
    setView((previous) => (previous.left === next.left && previous.width === next.width && previous.height === next.height ? previous : next));
  }, []);

  const locate = useCallback(
    (id: string) => {
      const column = layout.columns.find((item) => item.id === id);
      const container = viewport.current;
      if (container && column) {
        container.scrollLeft = Math.max(0, column.x - Math.max(0, container.clientWidth - column.width) / 2);
        container.scrollTop = 0;
      }
      revealNavigation(id);
      onSelect(id);
      updateVisible();
    },
    [layout, onSelect, revealNavigation, updateVisible],
  );

  const changeDensity = useCallback(
    (width: number) => {
      const container = viewport.current;
      const next = layoutColumns(ids, width);
      if (next.columnWidth === layout.columnWidth) return;
      if (container) pendingScroll.current = densityScroll(layout, next, container.scrollLeft, container.clientWidth / 2, container.clientWidth);
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
    const observer = new ResizeObserver(updateVisible);
    observer.observe(container);
    return () => observer.disconnect();
  }, [updateVisible, Boolean(rounds.length)]);
  useEffect(
    () => () => {
      if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current);
    },
    [],
  );
  useEffect(() => setHeights(new Map()), [mode, columnWidth]);

  const previousSelection = useRef('');
  useEffect(() => {
    if (!selectedId || previousSelection.current === selectedId || !ids.includes(selectedId)) return;
    previousSelection.current = selectedId;
    locate(selectedId);
  }, [ids, locate, selectedId]);

  const toggle = useCallback((id: string, open: boolean) => setExpanded((previous) => new Map(previous).set(id, open)), []);
  const measured = useCallback((id: string, height: number) => {
    setHeights((previous) => (previous.get(id) === height ? previous : new Map(previous).set(id, height)));
  }, []);
  const onScroll = () => {
    if (scrollFrame.current !== undefined) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = undefined;
      updateVisible();
    });
  };
  const goToMatch = (direction: 1 | -1) => {
    if (!matches.length) return;
    const next = matchCursor < 0 ? (direction === 1 ? 0 : matches.length - 1) : (matchCursor + direction + matches.length) % matches.length;
    setMatchCursor(next);
    locate(matches[next]!.executionId);
  };
  const first = window.columns[0];
  const canvasHeight = Math.max(view.height, ...heights.values());

  return (
    <section className="explorer-root" aria-label="运行图谱">
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
            onChange={(event) => setSearch(event.target.value)}
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
        <div className="explorer-view-mode" role="group" aria-label="图谱查看方式">
          <button type="button" aria-pressed={mode === 'calls'} onClick={() => setMode('calls')}>
            调用
          </button>
          <button type="button" aria-pressed={mode === 'timing'} onClick={() => setMode('timing')}>
            耗时
          </button>
        </div>
        <div className="explorer-density">
          <span>列宽</span>
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
      {rounds.length ? (
        <>
          <div className="explorer-navigation-heading">
            <span>
              轮次导航 <b>{rounds.length}</b>
            </span>
            <span>点击定位 · 浅底为可见范围</span>
          </div>
          <nav className="explorer-navigation" aria-label="问答轮次导航" ref={navigation}>
            {rounds.map((round, index) => {
              const match = matchById.get(round.id);
              return (
                <button key={round.id} type="button" className={`explorer-nav-card${selectedId === round.id ? ' explorer-nav-current' : ''}${window.visibleIds.includes(round.id) ? ' explorer-nav-visible' : ''}${match ? ' explorer-nav-match' : ''}`} data-execution-id={round.id} aria-current={selectedId === round.id ? 'true' : undefined} aria-label={`${qaName(index)}，${statusNames[round.status]}，${round.inputContent}`} onClick={() => locate(round.id)}>
                  <div className="explorer-nav-heading">
                    <strong>{qaName(index)}</strong>
                    {selectedId === round.id && round.status === 'succeeded' ? (
                      <Badge variant="secondary" className="explorer-current-tag">
                        当前查看
                      </Badge>
                    ) : (
                      <Status status={round.status} />
                    )}
                  </div>
                  <p>
                    {match ? (
                      <>
                        <span className="explorer-match-role">{roleNames[match.role]} · </span>
                        <Highlight text={match.snippet} search={search} />
                      </>
                    ) : (
                      round.inputContent
                    )}
                  </p>
                  <div className="explorer-nav-meta">
                    <span>{formatDuration(round.durationMs)}</span>
                    {round.memoryChanges.length > 0 && <span>记忆变化 {round.memoryChanges.length}</span>}
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
            <span>{mode === 'calls' ? '连线表示父子归属 · 序号表示同级调用顺序' : '轮内宽度表示耗时 · 点击节点查看记录'}</span>
          </div>
          <div className="explorer-viewport" ref={viewport} onScroll={onScroll} tabIndex={0} aria-label="调用图谱，横向浏览问答，纵向查看调用">
            <div className="explorer-graphs-canvas" style={{ width: layout.width, minHeight: canvasHeight }}>
              <div className="explorer-graphs-window" style={{ marginLeft: first?.x ?? 0 }}>
                {window.columns.map((column) => (
                  <RoundGraph key={column.id} round={rounds[column.index]!} graph={graphs.get(column.id)} index={column.index} width={column.width} selected={selectedId === column.id} mode={mode} expanded={expanded} toggle={toggle} inspect={onInspect} load={loadExecution} measured={measured} />
                ))}
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="explorer-empty">
          <div className="explorer-empty-glyph" aria-hidden="true">
            ◇
          </div>
          <h3>从一次对话开始</h3>
          <p>发送消息后，在这里查看上下文和实际调用路径。</p>
        </div>
      )}
    </section>
  );
}

export default RuntimeExplorer;
