/** Saved observation source metadata. It does not describe a resumable execution. */
export interface RecordingArchive {
  readonly sourceId: string;
  readonly rootIds: readonly string[];
  readonly revision: number;
  readonly state: 'open' | 'sealed' | 'incomplete';
}

export type RecordingArchiveOrigin = Omit<RecordingArchive, 'rootIds'>;

export function validateRecordingArchiveOrigin(value: unknown): asserts value is RecordingArchiveOrigin {
  if (!value || typeof value !== 'object') throw new Error('历史记录来源格式无效。');
  const source = value as RecordingArchiveOrigin;
  if (typeof source.sourceId !== 'string' || !source.sourceId || !Number.isSafeInteger(source.revision) || source.revision < 0 || !['open', 'sealed', 'incomplete'].includes(source.state)) throw new Error('历史记录来源格式无效。');
}

export function validateRecordingArchives(value: unknown): asserts value is readonly RecordingArchive[] {
  if (!Array.isArray(value)) throw new Error('历史记录来源格式无效。');
  const sources = new Set<string>();
  const roots = new Set<string>();
  for (const archive of value) {
    validateRecordingArchiveOrigin(archive);
    const source = archive as RecordingArchive;
    if (sources.has(source.sourceId) || !Array.isArray(source.rootIds) || source.rootIds.some((id) => typeof id !== 'string' || !id || roots.has(id))) throw new Error('历史记录来源归属无效。');
    sources.add(source.sourceId);
    for (const id of source.rootIds) {
      if (roots.has(id)) throw new Error('历史记录来源归属无效。');
      roots.add(id);
    }
  }
}
