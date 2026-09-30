import type { Recorder } from '../recorder.js';
import { RuntimeRecord } from './record.js';

export class RuntimeRecordHelper {
  static create(recorder: Recorder): RuntimeRecord {
    return recorder.add(new RuntimeRecord({ createdAt: recorder.clock.now() }));
  }
}
