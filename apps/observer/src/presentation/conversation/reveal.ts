import { useLayoutEffect, useMemo, useState } from 'react';
import { findLastIndex } from 'es-toolkit/compat';
import type { ConversationItem } from '../../state/conversation.js';
import { usePendingTextReveal } from '../text/react.js';

function assistant(row: ConversationItem): boolean {
  return row.kind === 'response' || (row.kind === 'message' && row.message.role === 'assistant');
}

function body(row: ConversationItem) {
  return row.kind === 'response' ? row.body : row.kind === 'message' && row.message.role === 'assistant' ? row : undefined;
}

/** Delay new assistant regions while a visible answer plays, never service work or user input. */
export function useConversationReveal(rows: readonly ConversationItem[]) {
  const [opened] = useState(() => new Set(rows.filter(assistant).map((row) => row.key)));
  const frontier = findLastIndex(rows, (row) => assistant(row) && opened.has(row.key));
  // A late body before an already visible assistant is history; it cannot close that region.
  const candidates = rows.slice(Math.max(0, frontier)).flatMap((row) => {
    const answer = body(row);
    return answer?.reveal ? [answer.key] : [];
  });
  const playing = usePendingTextReveal(candidates);
  const barrier = playing ? rows.findIndex((row) => body(row)?.key === playing) : -1;
  const visible = useMemo(() => rows.filter((row, index) => !assistant(row) || opened.has(row.key) || barrier < 0 || index <= barrier), [rows, barrier, opened]);
  useLayoutEffect(() => {
    opened.clear();
    for (const row of visible) if (assistant(row)) opened.add(row.key);
  }, [opened, visible]);
  return { rows: visible, playing };
}
