import type { Recorder } from '@capix/records';
import { bindRecording, type RecordingOptions } from '@capix/server-runtime/recording';
import type { CallableStructure, Composite } from '@capix/structure';
import { describeConversationValue } from './description.js';

/** Optional host installation. Business members retain their own deps/run/output and identity. */
export function createConversationRecording(scene: CallableStructure<'scene'> & Composite, recorder: Recorder, options: RecordingOptions = {}) {
  const installation = bindRecording(recorder, options);
  const pending = [scene, ...scene.members];
  for (let index = 0; index < pending.length; index++) {
    const current = pending[index]!;
    installation.describe(current, {
      ...(current === scene ? { role: 'conversation' } : {}),
      input: (value) => describeConversationValue(value),
      output: (value) => describeConversationValue(value),
      relationAccepted: (value) => describeConversationValue(value),
      relationHandled: (value) => describeConversationValue(value),
    });
    if (current !== scene && current.kind === 'group') pending.push(...current.members);
  }
  return installation;
}
