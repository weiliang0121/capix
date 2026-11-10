import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindRecording } from '@weiliang0121/capix-runtime/recording';

test('Runtime compatibility entrypoints keep record entities at their own public package roots', async () => {
  const runtime = await import('@weiliang0121/capix-runtime');
  const recording = await import('@weiliang0121/capix-runtime/recording');
  for (const name of ['Recorder', 'RecordBook', 'RecordTree', 'CallableRecord', 'RecordResource']) {
    assert.equal(name in runtime, false);
    assert.equal(name in recording, false);
  }
  assert.equal(recording.bindRecording, bindRecording);
});
