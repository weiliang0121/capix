import type { Recorder } from '../recorder.js';
import { RecordingRootRecord } from './record.js';

export class RecordingRootHelper {
  static create(recorder: Recorder): RecordingRootRecord {
    return recorder.add(new RecordingRootRecord({ createdAt: recorder.clock.now() }));
  }
}
