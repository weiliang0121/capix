import type { ExecutionSummary, InvocationSummary } from '@capix-observer/protocol';

export const axisWidth = 92;
export const columnGap = 20;
export const minimumColumnWidth = 320;
export const maximumColumnWidth = 960;
export const defaultColumnWidth = 440;

export interface ColumnLayout {
  width: number;
  columnWidth: number;
  columns: { id: string; x: number; width: number }[];
}

/** A QA has a readable width, independent of how long its execution took. */
export function layoutColumns(ids: readonly string[], requestedWidth: number): ColumnLayout {
  const columnWidth = Math.min(maximumColumnWidth, Math.max(minimumColumnWidth, Number.isFinite(requestedWidth) ? requestedWidth : defaultColumnWidth));
  return { columnWidth, width: Math.max(0, ids.length * (columnWidth + columnGap) - columnGap), columns: ids.map((id, index) => ({ id, x: index * (columnWidth + columnGap), width: columnWidth })) };
}

export function visibleColumns(layout: ColumnLayout, scrollLeft: number, viewportWidth: number): string[] {
  return layout.columns.filter((column) => column.x + column.width > scrollLeft && column.x < scrollLeft + viewportWidth).map((column) => column.id);
}

/** Preserve the QA and local position beneath the pointer when density changes. */
export function densityScroll(before: ColumnLayout, after: ColumnLayout, scrollLeft: number, anchor: number, viewportWidth: number): number {
  const position = Math.max(0, scrollLeft + anchor);
  const index = Math.min(Math.max(0, before.columns.length - 1), Math.floor(position / (before.columnWidth + columnGap)));
  const local = position - index * (before.columnWidth + columnGap);
  const mapped = index * (after.columnWidth + columnGap) + (local <= before.columnWidth ? (local / before.columnWidth) * after.columnWidth : after.columnWidth + local - before.columnWidth);
  return Math.min(Math.max(0, after.width - viewportWidth), Math.max(0, mapped - anchor));
}

export function wheelIntent(deltaX: number, deltaY: number, deltaMode: number, viewportWidth: number, shiftKey = false): { pan: number; density: number } {
  const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? viewportWidth : 1;
  if (shiftKey || Math.abs(deltaX) > Math.abs(deltaY)) return { pan: (shiftKey && !deltaX ? deltaY : deltaX) * unit, density: 0 };
  return { pan: 0, density: deltaY * unit };
}

export type CallFamily = 'selection' | 'answer' | 'memory' | 'neutral';
export interface CallGeometry {
  call: InvocationSummary;
  left: number;
  width: number;
  lane: number;
  family: CallFamily;
}

export interface InvocationLayout {
  calls: CallGeometry[];
  operationLanes: number;
  attemptLanes: number;
}

/** Width encodes time only within this execution. Running spans stop at observed facts. */
export function layoutInvocations(execution: ExecutionSummary): InvocationLayout {
  const byId = new Map(execution.calls.map((call) => [call.id, call]));
  const root = execution.calls.find((call) => call.recordType === 'execution');
  const start = root?.offsetMs ?? Math.min(0, ...execution.calls.map((call) => call.offsetMs));
  const observedEnd = Math.max(start, execution.observedOffsetMs, ...execution.calls.map((call) => call.offsetMs + (call.durationMs ?? 0)));
  const span = Math.max(0, root?.durationMs ?? observedEnd - start);
  const ancestors = (call: InvocationSummary): InvocationSummary[] => {
    const result: InvocationSummary[] = [];
    const visited = new Set([call.id]);
    let parent = call.parentId ? byId.get(call.parentId) : undefined;
    while (parent && !visited.has(parent.id)) {
      result.push(parent);
      visited.add(parent.id);
      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
    return result;
  };
  const calls = execution.calls.map((call): CallGeometry => {
    const parents = ancestors(call);
    const operations = parents.filter((parent) => parent.recordType === 'operation');
    const owner = call.recordType === 'operation' ? call : operations[0];
    const named = [owner, ...operations].find((item) => item && ['selection', 'answer', 'memory'].includes(item.name));
    const family = (named?.name ?? 'neutral') as CallFamily;
    const left = span ? Math.min(1, Math.max(0, (call.offsetMs - start) / span)) : 0;
    const recordedDuration = call.durationMs ?? Math.max(0, observedEnd - call.offsetMs);
    return { call, left, width: span ? Math.min(1 - left, Math.max(0, recordedDuration / span)) : 0, lane: call.recordType === 'attempt' ? Math.max(0, operations.length - 1) : operations.length, family };
  });
  return { calls, operationLanes: Math.max(1, ...calls.filter((item) => item.call.recordType === 'operation').map((item) => item.lane + 1)), attemptLanes: Math.max(1, ...calls.filter((item) => item.call.recordType === 'attempt').map((item) => item.lane + 1)) };
}

export function formatDuration(milliseconds: number | undefined): string {
  if (milliseconds === undefined) return '进行中';
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds < 10000 ? 2 : 1)} s`;
}
