import assert from 'node:assert/strict';
import { RecordBook, Recorder, RecordResource } from '@weiliang0121/capix-records';
import { Resource } from '@weiliang0121/capix-resources';
import { Node, Scene } from '@weiliang0121/capix-structure';
import { Resources, Runner } from '@weiliang0121/capix-runtime';
import { bindRecording } from '@weiliang0121/capix-runtime/recording';

// Records live independently; resources grant specific operations on this entity.
const recorder = new Recorder(new RecordBook());
const resources = new Resources().register(new Resource(recorder), RecordResource.write);
const note = new Node({
  deps: { records: RecordResource.write.request() },
  run: (work) => work.resources.records.create({ message: work.input }),
});

// This optional preset records actual calls in the same entity through its own windows.
const runner = new Runner(new Scene(note), resources, undefined, { observations: [bindRecording(recorder)] }).build();
const result = await runner.run('记录是一种可通过资源访问的实体');
console.log(result.kind, result.data.value);
console.log('已结束调用：', [...recorder.book.values()].filter((record) => record.kind === 'invocation' && record.status === 'succeeded').length);
console.log('记录自身写入的资源事实：', [...recorder.book.values()].filter((record) => record.kind === 'resource' && record.access === 'records.construct').length);

assert.equal(result.kind, 'custom');
assert.deepEqual(result.data.value, { message: '记录是一种可通过资源访问的实体' });
assert.equal([...recorder.book.values()].filter((record) => record.kind === 'invocation' && record.status === 'succeeded').length, 2);
assert.equal([...recorder.book.values()].filter((record) => record.kind === 'custom').length, 1);
assert.equal(runner.isRunning, false);
