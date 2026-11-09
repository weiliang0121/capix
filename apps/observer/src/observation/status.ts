import type { RecordingArchiveOrigin } from '@weiliang0121/capix-protocol';

export type ObservationStatus = 'running' | 'succeeded' | 'failed' | 'unresolved';

/** Historic facts retain their wire status; only presentation distinguishes a stopped observation. */
export function observationStatus<Status extends 'running' | 'succeeded' | 'failed'>(status: Status, archive?: RecordingArchiveOrigin): Status | 'unresolved' {
  return archive && status === 'running' ? 'unresolved' : status;
}

export function archiveNotice(archive: RecordingArchiveOrigin): string {
  return archive.state === 'incomplete' ? '历史记录存在已知缺口，以下仅展示已保存的事实。' : archive.state === 'open' ? '历史记录未正常封存，完整性尚未确认。' : '历史记录 · 已封存';
}
