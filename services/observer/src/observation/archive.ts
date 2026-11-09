import type { RecordingArchive, RecordingArchiveOrigin } from '@weiliang0121/capix-protocol';
import type { RecordBook } from '@weiliang0121/capix-records';

/** Resolve saved provenance through direct record links, without copying ancestor IDs into records. */
export function executionArchive(book: RecordBook, archives: readonly RecordingArchive[] | undefined, executionId: string): RecordingArchiveOrigin | undefined {
  if (!archives?.length) return;
  let record = book.get(executionId);
  const visited = new Set<string>();
  while (record?.parentId) {
    if (visited.has(record.id)) throw new Error('记录归属存在循环。');
    visited.add(record.id);
    record = book.get(record.parentId);
  }
  const source = archives.find((archive) => archive.rootIds.includes(record?.id ?? ''));
  if (source) return { sourceId: source.sourceId, revision: source.revision, state: source.state };
}
