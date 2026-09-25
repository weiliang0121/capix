import type { ObserverOverview } from '@capix-observer/protocol';

export interface SearchMatch {
  executionId: string;
  role: 'user' | 'assistant';
  snippet: string;
}

/** One match per QA; prefer the user input if both sides contain the search text. */
export function searchExecutions(overview: ObserverOverview, search: string): SearchMatch[] {
  const term = search.trim().toLocaleLowerCase();
  if (!term) return [];
  const messages = new Map(overview.messages.map((entry) => [entry.index, entry.message]));
  return overview.executions.flatMap((execution) => {
    const candidates = [
      { role: 'user' as const, content: messages.get(execution.inputIndex)?.content ?? '' },
      { role: 'assistant' as const, content: execution.response?.content ?? '' },
    ];
    const found = candidates.find(({ content }) => content.toLocaleLowerCase().includes(term));
    if (!found) return [];
    const position = found.content.toLocaleLowerCase().indexOf(term);
    const start = Math.max(0, position - 18);
    const end = Math.min(found.content.length, position + term.length + 42);
    return [{ executionId: execution.id, role: found.role, snippet: `${start ? '…' : ''}${found.content.slice(start, end)}${end < found.content.length ? '…' : ''}` }];
  });
}
