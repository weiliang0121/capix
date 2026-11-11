import { ResourceOffer } from '@weiliang0121/capix-resources';
import type { RecordEntry } from './data/index.js';
import type { RecordBookState } from './book.js';
import { BaseRecord } from './record.js';
import type { Recorder } from './recorder.js';
import { snapshotValue } from './value/snapshot.js';

export interface RecordReader {
  get(id: string): RecordEntry | undefined;
  snapshot(): RecordBookState;
}

export interface RecordCreator {
  create(value: unknown): RecordEntry;
}

/** Ordinary callers supply content, never record identity or invocation lifecycle facts. */
class CustomRecord extends BaseRecord<unknown> {
  constructor(value: unknown) {
    super(snapshotValue(value));
    Object.freeze(this);
  }
}

function entrySnapshot(record: BaseRecord<unknown>): RecordEntry {
  return snapshotValue({ kind: record.kind, data: record.toJSON() });
}

/** Synchronous content access; live records remain owned by the recorder. */
export const RecordResource = Object.freeze({
  read: new ResourceOffer<Recorder, RecordReader>({
    name: 'records.read',
    expose: (recorder, activity) =>
      Object.freeze({
        get(id: string): RecordEntry | undefined {
          return activity.runSync('get', { input: () => ({ id }), output: (entry) => ({ id, found: entry !== undefined }) }, () => {
            const record = recorder.book.get(id);
            return record ? entrySnapshot(record) : undefined;
          });
        },
        snapshot(): RecordBookState {
          return activity.runSync('snapshot', { output: (state) => ({ count: state.entries.length }) }, () => recorder.book.exportState());
        },
      }),
    timing: 'access',
    describe: (recorder) => ({ recorderId: recorder.id }),
  }),
  write: new ResourceOffer<Recorder, RecordCreator>({
    name: 'records.write',
    expose: (recorder, activity) =>
      Object.freeze({
        create(value: unknown): RecordEntry {
          return activity.runSync('create', { output: (entry) => ({ id: entry.data.id, kind: entry.kind }) }, () => entrySnapshot(recorder.add(new CustomRecord(value))));
        },
      }),
    timing: 'access',
    describe: (recorder) => ({ recorderId: recorder.id, kind: 'custom' }),
  }),
});
