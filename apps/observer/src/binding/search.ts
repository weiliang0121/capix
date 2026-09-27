import type { RoundView, SearchMatch } from '../state/data.js';

/** One match per QA; prefer the user input if both sides contain the search text. */
export function searchRounds(rounds: readonly RoundView[], search: string): SearchMatch[] {
  const term = search.trim().toLocaleLowerCase();
  if (!term) return [];
  return rounds.flatMap((execution) => {
    const candidates = [
      { role: 'user' as const, content: execution.inputContent },
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
