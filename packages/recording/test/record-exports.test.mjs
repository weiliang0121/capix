import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as runtime from '@weiliang0121/capix-runtime';
import * as recording from '@weiliang0121/capix-recording';
import * as records from '@weiliang0121/capix-records';

test('recording installs through its own root while record entities stay in records', () => {
  for (const name of ['bindRecording', 'invocationRecording', 'RecordingInstallation', 'InvocationRecording', 'InvocationRecordAccess']) {
    assert.ok(name in recording);
    assert.equal(name in runtime, false);
    assert.equal(name in records, false);
  }
  for (const name of ['Recorder', 'RecordBook', 'RecordTree', 'CallableRecord', 'RecordResource', 'observeMemory', 'snapshotValue']) {
    assert.ok(name in records);
    assert.equal(name in runtime, false);
    assert.equal(name in recording, false);
  }
  assert.throws(() => import.meta.resolve('@weiliang0121/capix-runtime/recording'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});
