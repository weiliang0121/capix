import { Node, checkpointPoint } from '@weiliang0121/capix-structure';
import type { ResourcesOf } from '@weiliang0121/capix-resources';
import type { ToolResult } from '@weiliang0121/capix-model-provider';
import { codec } from '../../recovery/codecs.js';
import { assertToolOutputBytes } from '../../tools/budget.js';
import { tool } from '../../tools/registration.js';
import type { ToolConversationPolicy } from '../../hosting/tool-policy.js';
import { HistoryToolResource, HistoryLookupError } from './resource.js';
import { historyInputSchemas, readMessageOutputSchema, searchHistoryOutputSchema, type ReadMessageInput, type ReadMessageOutput, type SearchHistoryInput, type SearchHistoryOutput } from './types.js';

function failure(error: unknown): ToolResult {
  if (!(error instanceof HistoryLookupError)) throw error;
  return { status: 'error', content: [{ kind: 'text', text: error.message }] };
}
function result(value: ReadMessageOutput | SearchHistoryOutput): ToolResult {
  // The feedback body is a persisted string: use the same Schema field order on the
  // initial result and on a result decoded from CP, before fixed feedback confirmation.
  const output = 'matches' in value ? searchHistoryOutputSchema.parse(value) : readMessageOutputSchema.parse(value);
  return { status: 'ok', content: [{ kind: 'text', text: JSON.stringify(output) }] };
}

/** Ordinary pure-read nodes: public tool Schema and actual input codec share one definition. */
export function createHistoryTools(policy: ToolConversationPolicy) {
  const schemas = historyInputSchemas(policy.history);
  const deps = { history: HistoryToolResource.request() };
  const rawRead = codec(readMessageOutputSchema);
  const rawSearch = codec(searchHistoryOutputSchema);
  const readCodec = { encode: (value: ReadMessageOutput) => rawRead.encode(assertToolOutputBytes(value, policy.history.maxOutputBytes)), decode: (value: Parameters<typeof rawRead.decode>[0]) => assertToolOutputBytes(rawRead.decode(value), policy.history.maxOutputBytes) };
  const searchCodec = { encode: (value: SearchHistoryOutput) => rawSearch.encode(assertToolOutputBytes(value, policy.history.maxOutputBytes)), decode: (value: Parameters<typeof rawSearch.decode>[0]) => assertToolOutputBytes(rawSearch.decode(value), policy.history.maxOutputBytes) };
  const readDone = checkpointPoint<'node', ReadMessageInput, ReadMessageOutput>()({
    name: 'completed',
    state: readCodec,
    references: {},
    check(value, facts) {
      if (value.index !== facts.input.index || value.offset !== (facts.input.offset ?? 0) || value.index >= value.before || value.text.length > (facts.input.length ?? policy.history.maxReadLength) || value.offset + value.text.length > value.totalLength || value.nextOffset !== (value.offset + value.text.length < value.totalLength ? value.offset + value.text.length : null)) throw new Error('Historical read result differs from its fixed request');
    },
    resume: { run: (_work, value) => value },
  });
  const searchDone = checkpointPoint<'node', SearchHistoryInput, SearchHistoryOutput>()({
    name: 'completed',
    state: searchCodec,
    references: {},
    check(value, facts) {
      if (value.query !== facts.input.query || value.fromIndex !== (facts.input.fromIndex ?? 0) || value.matches.length > (facts.input.limit ?? policy.history.maxSearchResults) || value.scanned > policy.history.maxSearchMessages || value.fromIndex + value.scanned > value.before || value.nextIndex !== (value.fromIndex + value.scanned < value.before ? value.fromIndex + value.scanned : null) || value.matches.some((item, index) => item.index < value.fromIndex || item.index >= value.fromIndex + value.scanned || (index > 0 && item.index <= value.matches[index - 1]!.index) || item.offset + item.text.length > item.totalLength || item.nextOffset !== (item.offset + item.text.length < item.totalLength ? item.offset + item.text.length : null))) throw new Error('Historical search result differs from its fixed request');
    },
    resume: { run: (_work, value) => value },
  });
  const read = new Node<ReadMessageInput, ReadMessageOutput, ResourcesOf<typeof deps>>({
    name: 'read-history-message',
    deps,
    checkpoint: { key: 'conversation.history.read-message', version: 1, input: codec(schemas.read), output: readCodec, points: [readDone] },
    async run(work) {
      const value = await work.resources.history.read(schemas.read.parse(work.input));
      assertToolOutputBytes(value, policy.history.maxOutputBytes);
      work.checkpoint?.({ point: readDone, state: value, refs: {} });
      return value;
    },
  });
  const search = new Node<SearchHistoryInput, SearchHistoryOutput, ResourcesOf<typeof deps>>({
    name: 'search-history',
    deps,
    checkpoint: { key: 'conversation.history.search', version: 1, input: codec(schemas.search), output: searchCodec, points: [searchDone] },
    async run(work) {
      const value = await work.resources.history.search(schemas.search.parse(work.input));
      assertToolOutputBytes(value, policy.history.maxOutputBytes);
      work.checkpoint?.({ point: searchDone, state: value, refs: {} });
      return value;
    },
  });
  return Object.freeze({ search_history: tool(search, { description: 'Search literal text in formal messages before the current question. Returns true message indexes, UTF-16 offsets and bounded excerpts. Follow nextIndex to search further; use read_message to read an original message.', input: schemas.search, maxOutputBytes: policy.history.maxOutputBytes, result: { succeeded: result, failed: failure } }), read_message: tool(read, { description: 'Read a bounded fragment of a formal historical message by its exact index. offset and length use UTF-16 positions. Follow nextOffset until null; current question and later messages are outside this tool.', input: schemas.read, maxOutputBytes: policy.history.maxOutputBytes, result: { succeeded: result, failed: failure } }) });
}
