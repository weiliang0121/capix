import { isDeepStrictEqual } from 'node:util';
import { ResourceOffer, ResourcePortError } from '@weiliang0121/capix-resources';
import { RuntimeError } from '@weiliang0121/capix-contracts';
import type { Transcript } from '@weiliang0121/capix-transcript';
import type { ConversationMaterialInput } from '../../materials/input.js';
import { assertToolFeedbackBytes, assertToolOutputBytes, ToolBudgetError } from '../../tools/budget.js';
import type { ToolConversationPolicy } from '../../hosting/tool-policy.js';
import type { SearchHistoryInput, ReadMessageInput, SearchHistoryOutput, ReadMessageOutput } from './types.js';

export interface HistoryToolSource {
  readonly transcript: Transcript;
  readonly query: ConversationMaterialInput['query'];
  readonly policy: ToolConversationPolicy;
}
export class HistoryLookupError extends Error {}
const maximumCallId = '\u0000'.repeat(256);
function fits(source: HistoryToolSource, output: unknown): boolean {
  try {
    assertToolOutputBytes(output, source.policy.history.maxOutputBytes);
    assertToolFeedbackBytes(maximumCallId, { status: 'ok', content: [{ kind: 'text', text: JSON.stringify(output) }] }, source.policy.budgets);
    return true;
  } catch (error) {
    if (error instanceof ToolBudgetError) return false;
    throw error;
  }
}
function assertBounds(source: HistoryToolSource, output: unknown): void {
  assertToolOutputBytes(output, source.policy.history.maxOutputBytes);
  assertToolFeedbackBytes(maximumCallId, { status: 'ok', content: [{ kind: 'text', text: JSON.stringify(output) }] }, source.policy.budgets);
}
function checkedSource(source: HistoryToolSource): void {
  const query = source.query;
  if (source.transcript.id !== query.transcriptId || !isDeepStrictEqual(source.transcript.get(query.index), { role: 'user', content: query.content })) throw new ResourcePortError('History tools require the exact accepted query', { cause: new RuntimeError('CHECKPOINT_CONTENT_CHANGED', 'Historical source differs from the fixed query') });
}
function message(source: HistoryToolSource, index: number) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= source.query.index) throw new HistoryLookupError('Message index is outside the history before this question.');
  const value = source.transcript.get(index);
  if (!value) throw new ResourcePortError('A fixed historical message is missing');
  return value;
}
function endBoundary(text: string, end: number): number {
  return end > 0 && end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!) && /[\uDC00-\uDFFF]/u.test(text[end]!) ? end - 1 : end;
}
function read(source: HistoryToolSource, input: ReadMessageInput): ReadMessageOutput {
  checkedSource(source);
  const value = message(source, input.index);
  const offset = input.offset ?? 0;
  const length = input.length ?? source.policy.history.maxReadLength;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 2 || length > source.policy.history.maxReadLength) throw new HistoryLookupError('Invalid message fragment range.');
  if (offset > value.content.length || offset !== endBoundary(value.content, offset)) throw new HistoryLookupError('Offset must be a valid UTF-16 position in the requested message.');
  let end = endBoundary(value.content, Math.min(value.content.length, offset + length));
  while (end >= offset) {
    const output = { transcriptId: source.transcript.id, before: source.query.index, index: input.index, role: value.role, offset, text: value.content.slice(offset, end), nextOffset: end < value.content.length ? end : null, totalLength: value.content.length };
    if (fits(source, output) && (end > offset || end === value.content.length)) return Object.freeze(output);
    if (end <= offset) {
      const minimumEnd = Math.min(value.content.length, offset + (/[\uD800-\uDBFF]/u.test(value.content[offset] ?? '') ? 2 : 1));
      assertBounds(source, { ...output, text: value.content.slice(offset, minimumEnd), nextOffset: minimumEnd < value.content.length ? minimumEnd : null });
      throw new Error('History slice cannot make forward progress');
    }
    end = endBoundary(value.content, end - 1);
  }
  throw new Error('Invalid history slice boundary');
}
function search(source: HistoryToolSource, input: SearchHistoryInput): SearchHistoryOutput {
  checkedSource(source);
  const fromIndex = input.fromIndex ?? 0;
  const limit = input.limit ?? source.policy.history.maxSearchResults;
  if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 128 || !Number.isSafeInteger(fromIndex) || fromIndex < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > source.policy.history.maxSearchResults) throw new HistoryLookupError('Invalid history search query or page.');
  if (fromIndex > source.query.index) throw new HistoryLookupError('Search cursor is outside the history before this question.');
  const end = Math.min(source.query.index, fromIndex + source.policy.history.maxSearchMessages);
  const matches: SearchHistoryOutput['matches'][number][] = [];
  let cursor = fromIndex;
  let rejected: SearchHistoryOutput | undefined;
  for (; cursor < end && matches.length < limit; cursor++) {
    const value = message(source, cursor);
    const offset = value.content.indexOf(input.query);
    if (offset < 0) continue;
    let stop = endBoundary(value.content, Math.min(value.content.length, offset + source.policy.history.excerptLength));
    const candidate = () => ({ index: cursor, role: value.role, offset, text: value.content.slice(offset, stop), nextOffset: stop < value.content.length ? stop : null, totalLength: value.content.length });
    while (stop >= offset) {
      const output = { transcriptId: source.transcript.id, before: source.query.index, query: input.query, fromIndex, matches: [...matches, candidate()], nextIndex: cursor + 1 < source.query.index ? cursor + 1 : null, scanned: cursor + 1 - fromIndex };
      if (fits(source, output)) {
        matches.push(Object.freeze(candidate()));
        break;
      }
      rejected = output;
      stop = endBoundary(value.content, stop - 1);
    }
    if (stop < offset) break; // Retry this exact message on the next page, never skip it.
  }
  const output: SearchHistoryOutput = { transcriptId: source.transcript.id, before: source.query.index, query: input.query, fromIndex, matches: Object.freeze(matches), nextIndex: cursor < source.query.index ? cursor : null, scanned: cursor - fromIndex };
  assertBounds(source, output);
  if (cursor === fromIndex && cursor < end && !matches.length) {
    // Report the actual bounded value and limit, rather than inventing a byte count.
    assertBounds(source, rejected);
    throw new Error('History search cannot make forward progress');
  }
  return Object.freeze(output);
}
/** A fixed query boundary, not access to the current/full Transcript. Appends cannot widen it. */
export const HistoryToolResource = new ResourceOffer({
  name: 'conversation.history.tools',
  methods: { search, read },
  observation: { source: (source) => ({ transcriptId: source.query.transcriptId, before: source.query.index }), methods: { search: { input: (input) => ({ fromIndex: input.fromIndex, limit: input.limit }), output: (output) => ({ matches: output.matches.length, nextIndex: output.nextIndex }) }, read: { input: (input) => input, output: (output) => ({ index: output.index, offset: output.offset, nextOffset: output.nextOffset }) } } },
});
