import { ResourceOffer } from '@weiliang0121/capix-resources';
import type { InvocationBoundaryValue, RecordMutation } from './data/index.js';
import type { BaseRecord } from './record.js';
import type { Recorder } from './recorder.js';
import { InvocationBoundaryRecordHelper } from './invocation/boundary/helper.js';
import type { InvocationBoundaryRecord } from './invocation/boundary/record.js';
import { RecordingRootHelper } from './root/helper.js';
import type { RecordingRootRecord } from './root/record.js';

/** Host-side record construction; live record handles must not enter ordinary business resources. */
export interface RecordWriter {
  root(): RecordingRootRecord;
  add<RecordType extends BaseRecord<unknown>>(record: RecordType): RecordType;
  update<RecordType extends BaseRecord<unknown>>(record: RecordType, apply: (record: RecordType) => void, describe?: (record: RecordType) => RecordMutation): void;
  boundary(location: Parameters<typeof InvocationBoundaryRecordHelper.create>[1], type: InvocationBoundaryValue['type']): InvocationBoundaryRecord;
}

/** Install in independent observation windows, without observing this writer through itself. */
export const RecordWriterResource = new ResourceOffer<Recorder, RecordWriter>({
  name: 'records.construct',
  expose: (recorder, activity): RecordWriter =>
    Object.freeze({
      root(): RecordingRootRecord {
        return activity.runSync('root', { output: (record) => ({ id: record.id, kind: record.kind }) }, () => RecordingRootHelper.create(recorder));
      },
      add<RecordType extends BaseRecord<unknown>>(record: RecordType): RecordType {
        return activity.runSync('add', { input: () => ({ id: record.id, kind: record.kind }), output: (added) => ({ id: added.id, kind: added.kind }) }, () => recorder.add(record));
      },
      update<RecordType extends BaseRecord<unknown>>(record: RecordType, apply: (record: RecordType) => void, describe?: (record: RecordType) => RecordMutation): void {
        activity.runSync('update', { input: () => ({ id: record.id, kind: record.kind }) }, () => recorder.update(record, apply, describe));
      },
      boundary(location: Parameters<typeof InvocationBoundaryRecordHelper.create>[1], type: InvocationBoundaryValue['type']): InvocationBoundaryRecord {
        return activity.runSync('boundary', { input: () => ({ callId: location.callId, type }), output: (record) => ({ id: record.id, callId: record.callId, type }) }, () => InvocationBoundaryRecordHelper.create(recorder, location, type));
      },
    }),
  timing: 'access',
  describe: (recorder) => ({ recorderId: recorder.id }),
});
