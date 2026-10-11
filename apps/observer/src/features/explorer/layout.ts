import { defaultColumnWidth, maximumColumnWidth, minimumColumnWidth } from '../../state/preferences.js';
export { defaultColumnWidth, maximumColumnWidth, minimumColumnWidth } from '../../state/preferences.js';
import type { ExecutionSummary, InvocationSummary } from '@capix/protocol';

export const columnGap = 20;

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

export interface ColumnWindow {
  columns: (ColumnLayout['columns'][number] & { index: number })[];
  visibleIds: string[];
}

/** Keep scrolling work proportional to the viewport, including adjacent QA for smooth entry. */
export function visibleColumnWindow(layout: ColumnLayout, scrollLeft: number, viewportWidth: number, overscan = 1): ColumnWindow {
  if (!layout.columns.length || !Number.isFinite(scrollLeft) || !Number.isFinite(viewportWidth) || viewportWidth <= 0) return { columns: [], visibleIds: [] };
  const left = Math.max(0, scrollLeft);
  if (left >= layout.width) return { columns: [], visibleIds: [] };
  const right = Math.min(layout.width, left + viewportWidth);
  const stride = layout.columnWidth + columnGap;
  const first = Math.floor(left / stride) + (left % stride >= layout.columnWidth ? 1 : 0);
  const end = Math.min(layout.columns.length, Math.ceil(right / stride));
  const margin = Number.isFinite(overscan) ? Math.max(0, Math.floor(overscan)) : 0;
  const start = Math.max(0, first - margin);
  const limit = Math.min(layout.columns.length, end + margin);
  return { columns: layout.columns.slice(start, limit).map((column, index) => ({ ...column, index: start + index })), visibleIds: layout.columns.slice(first, end).map((column) => column.id) };
}

/** Preserve the QA and local position beneath the pointer when density changes. */
export function densityScroll(before: ColumnLayout, after: ColumnLayout, scrollLeft: number, anchor: number, viewportWidth: number): number {
  const position = Math.max(0, scrollLeft + anchor);
  const index = Math.min(Math.max(0, before.columns.length - 1), Math.floor(position / (before.columnWidth + columnGap)));
  const local = position - index * (before.columnWidth + columnGap);
  const mapped = index * (after.columnWidth + columnGap) + (local <= before.columnWidth ? (local / before.columnWidth) * after.columnWidth : after.columnWidth + local - before.columnWidth);
  return Math.min(Math.max(0, after.width - viewportWidth), Math.max(0, mapped - anchor));
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
