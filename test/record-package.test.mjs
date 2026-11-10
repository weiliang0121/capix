import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChangeBuffer } from '@weiliang0121/capix-changes';
import { Resource, Resources as ResourceBindings, ResourceAccessClosed } from '@weiliang0121/capix-resources';
import { BaseRecord, CallableRecord, InvocationBoundaryRecord, RecordBook, Recorder, RecordResource, ResourceRecord } from '@weiliang0121/capix-records';
import { RecordWriterResource } from '@weiliang0121/capix-records/construction';
import { Node, Scene } from '@weiliang0121/capix-structure';
import { Runner, Resources } from '@weiliang0121/capix-runtime';
import { bindRecording } from '@weiliang0121/capix-runtime/recording';
import { readOutput } from '@weiliang0121/capix-protocol';

function contentAccess(recorder) {
  const resource = new Resource(recorder);
  return new ResourceBindings().register(resource, RecordResource.read).register(resource, RecordResource.write).bind({ read: RecordResource.read.request(), write: RecordResource.write.request() }).open();
}

function writerAccess(recorder) {
  return new ResourceBindings().register(new Resource(recorder), RecordWriterResource).bind({ writer: RecordWriterResource.request() }).open();
}

test('record entities have independent public entries and no callable or memory implementation dependency', async () => {
  const directory = fileURLToPath(new URL('../packages/records/', import.meta.url));
  const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  const forbidden = ['@weiliang0121/capix-runtime', '@weiliang0121/capix-structure', '@weiliang0121/capix-memory', '@capix/observer-service'];
  assert.equal(manifest.name, '@weiliang0121/capix-records');
  assert.deepEqual(Object.keys(manifest.exports).sort(), ['.', './construction']);
  for (const dependency of [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]) assert.ok(!forbidden.includes(dependency), `records cannot depend on ${dependency}`);
  async function inspect(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = resolve(path, entry.name);
      if (entry.isDirectory()) await inspect(file);
      else if (/\.(?:ts|js)$/.test(entry.name)) {
        const source = await readFile(file, 'utf8');
        for (const match of source.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)) {
          const specifier = match[2];
          assert.ok(!forbidden.some((name) => specifier === name || specifier.startsWith(`${name}/`)), `${file} cannot import ${specifier}`);
          if (specifier.startsWith('.')) assert.ok(!relative(directory, resolve(dirname(file), specifier)).startsWith('..'), `${file} crosses its package boundary`);
        }
      }
    }
  }
  await inspect(resolve(directory, 'src'));
  await inspect(resolve(directory, 'dist'));
  const records = await import('@weiliang0121/capix-records');
  const construction = await import('@weiliang0121/capix-records/construction');
  const runtime = await import('@weiliang0121/capix-runtime');
  const recording = await import('@weiliang0121/capix-runtime/recording');
  for (const name of ['Recorder', 'RecordBook', 'RecordTree', 'CallableRecord', 'RecordResource']) {
    assert.ok(name in records);
    assert.equal(name in runtime, false);
    assert.equal(name in recording, false);
  }
  for (const name of ['Runner', 'Invocation', 'Scene', 'Node', 'bindRecording', 'InvocationRecording', 'RecordWriterResource']) assert.equal(name in records, false);
  assert.equal(construction.RecordWriterResource, RecordWriterResource);
  assert.equal(recording.bindRecording, bindRecording);
  for (const path of ['@weiliang0121/capix-records/recorder', '@weiliang0121/capix-records/src/record.js', '@weiliang0121/capix-records/dist/record.js']) await assert.rejects(import(path), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});

test('ordinary record resources create custom content and return isolated snapshots within their access window', () => {
  const recorder = new Recorder(new RecordBook());
  const access = contentAccess(recorder);
  const { read, write } = access.endpoints;
  try {
    const content = { id: 'caller-id', kind: 'invocation', parentId: 'caller-parent', nested: { text: 'original' } };
    const created = write.create(content);
    assert.equal(created.kind, 'custom');
    assert.notEqual(created.data.id, content.id);
    assert.equal(Object.hasOwn(created.data, 'parentId'), false);
    assert.deepEqual(created.data.value, content);
    assert.equal('toJSON' in created.data, false);
    assert.equal(created.data instanceof BaseRecord, false);
    content.nested.text = 'changed by caller';
    assert.equal(created.data.value.nested.text, 'original');
    assert.equal(recorder.book.get(created.data.id).value.nested.text, 'original');
    const retrieved = read.get(created.data.id);
    assert.deepEqual(retrieved, created);
    assert.notEqual(retrieved, created);
    assert.notEqual(retrieved.data.value, recorder.book.get(created.data.id).value);
    assert.ok(Object.isFrozen(retrieved) && Object.isFrozen(retrieved.data) && Object.isFrozen(retrieved.data.value.nested));
    assert.equal(Reflect.set(retrieved.data.value.nested, 'text', 'changed snapshot'), false);
    const snapshot = read.snapshot();
    write.create({ text: 'later record' });
    assert.equal(snapshot.entries.length, 1);
    assert.equal(read.snapshot().entries.length, 2);
    assert.equal(read.get('missing'), undefined);
    assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.entries));
  } finally {
    access.close();
  }
  const revision = recorder.revision;
  assert.throws(() => read.get('missing'), ResourceAccessClosed);
  assert.throws(() => read.snapshot(), ResourceAccessClosed);
  assert.throws(() => write.create('too late'), ResourceAccessClosed);
  assert.equal(recorder.revision, revision);
});

test('custom content validation does not register invalid values and historical records remain read-only', () => {
  const changes = new ChangeBuffer();
  const recorder = new Recorder(new RecordBook(), { changes });
  const access = contentAccess(recorder);
  let saved;
  let id;
  try {
    const cycle = {};
    cycle.self = cycle;
    for (const content of [() => undefined, recorder, cycle]) {
      assert.throws(() => access.endpoints.write.create(content));
      assert.equal(recorder.revision, 0);
      assert.equal([...recorder.book.values()].length, 0);
      assert.equal(changes.size, 0);
    }
    id = access.endpoints.write.create({ text: 'retained' }).data.id;
    saved = access.endpoints.read.snapshot();
  } finally {
    access.close();
  }
  const restored = new Recorder(RecordBook.restore(JSON.parse(JSON.stringify(saved))));
  const history = contentAccess(restored);
  const construction = writerAccess(restored);
  try {
    assert.deepEqual(history.endpoints.read.snapshot(), saved);
    const record = restored.book.get(id);
    assert.equal(record.historical, true);
    let applied = false;
    assert.throws(
      () =>
        construction.endpoints.writer.update(record, () => {
          applied = true;
        }),
      /Historical record is read-only/,
    );
    assert.throws(() => construction.endpoints.writer.add(record), /Historical record cannot be registered again/);
    assert.equal(applied, false);
    assert.equal(restored.revision, 0);
    assert.deepEqual(history.endpoints.read.snapshot(), saved);
  } finally {
    history.close();
    construction.close();
  }
});

test('host writers preserve exact record handles, relations and window expiry', () => {
  const recorder = new Recorder(new RecordBook());
  const access = writerAccess(recorder);
  const foreign = writerAccess(new Recorder(new RecordBook()));
  const writer = access.endpoints.writer;
  let call;
  let location;
  try {
    const root = writer.root();
    assert.equal(recorder.book.get(root.id), root);
    call = new CallableRecord({ contextId: 'real-call', structureKind: 'scene', parentId: root.id }, { input: null, startedAt: '2026-10-26T00:00:00.000Z' });
    assert.equal(writer.add(call), call);
    assert.deepEqual(root.childIds, [call.id]);
    location = { start: 0, scopeId: call.id, callId: call.id, occurredAt: '2026-10-26T00:00:00.000Z', offsetMs: 0 };
    const started = writer.boundary(location, 'call');
    assert.ok(started instanceof InvocationBoundaryRecord);
    assert.equal(started.parentId, call.id);
    let applied = false;
    assert.throws(
      () =>
        writer.update({ id: call.id }, () => {
          applied = true;
        }),
      /not registered with this Recorder/,
    );
    assert.throws(
      () =>
        foreign.endpoints.writer.update(call, () => {
          applied = true;
        }),
      /not registered with this Recorder/,
    );
    assert.equal(applied, false);
    writer.update(call, (record) => {
      assert.equal(record, call);
      record.complete('finished');
    });
    const finished = writer.boundary({ ...location, offsetMs: 1 }, 'return');
    assert.equal(call.status, 'succeeded');
    assert.deepEqual(call.childIds, [started.id, finished.id]);
  } finally {
    access.close();
    foreign.close();
  }
  const revision = recorder.revision;
  assert.throws(() => writer.root(), ResourceAccessClosed);
  assert.throws(() => writer.add(call), ResourceAccessClosed);
  assert.throws(() => writer.update(call, () => assert.fail('expired writer must not run callbacks')), ResourceAccessClosed);
  assert.throws(() => writer.boundary(location, 'return'), ResourceAccessClosed);
  assert.equal(recorder.revision, revision);
});

test('automatic recording uses independent writer windows without changing results or recording itself', async () => {
  const recorder = new Recorder(new RecordBook());
  const installation = bindRecording(recorder);
  let created;
  const node = new Node({
    deps: { records: RecordResource.write.request() },
    run: (work) => {
      created = work.resources.records.create({ note: 'business content' });
      return work.input;
    },
  });
  const resources = new Resources().register(new Resource(recorder), RecordResource.write);
  const runner = new Runner(new Scene(node), resources, undefined, { observations: [installation] }).build();
  const output = { content: 'same reference' };
  assert.deepEqual(await runner.run(output), output);
  const records = [...recorder.book.values()];
  const calls = records.filter((record) => record instanceof CallableRecord);
  const scene = calls.find((record) => record.structureKind === 'scene');
  const child = calls.find((record) => record.structureKind === 'node');
  assert.equal(calls.length, 2);
  assert.equal(scene.parentId, installation.root.id);
  assert.equal(child.parentId, scene.id);
  assert.ok(scene.childIds.includes(child.id));
  for (const call of calls) {
    assert.equal(call.status, 'succeeded');
    assert.deepEqual(readOutput(call.value), output);
    assert.equal(call.value.resultOf, 2);
    assert.deepEqual(
      records.filter((record) => record instanceof InvocationBoundaryRecord && record.callId === call.id).map((record) => record.value.type),
      ['call', 'return'],
    );
  }
  assert.equal(recorder.book.get(created.data.id).kind, 'custom');
  const resourceFacts = records.filter((record) => record instanceof ResourceRecord);
  assert.deepEqual(
    resourceFacts.map((record) => record.phase),
    ['bound', 'available', 'started', 'returned'],
  );
  assert.ok(resourceFacts.every((record) => record.access === 'records.write'));
  assert.equal(
    resourceFacts.some((record) => record.access === 'records.construct'),
    false,
  );
});

test('the automatic recording installation cannot supply its host writer to business work', () => {
  const recorder = new Recorder(new RecordBook());
  const node = new Node({ deps: { writer: RecordWriterResource.request() }, run: () => assert.fail('unbound business must not execute') });
  assert.throws(() => new Runner(new Scene(node), new Resources(), undefined, { observations: [bindRecording(recorder)] }).build(), /Expected one resource provider/);
});

test('record write failure follows isolate or propagate without replaying successful business work', async () => {
  for (const failure of ['isolate', 'propagate']) {
    const cause = new Error(`reject ${failure} record return`);
    let rejectedWrites = 0;
    class RejectingRecorder extends Recorder {
      update(record, apply, describe) {
        if (record instanceof CallableRecord && record.structureKind === 'node' && record.value.processes.length === 1) {
          rejectedWrites++;
          throw cause;
        }
        return super.update(record, apply, describe);
      }
    }
    const recorder = new RejectingRecorder(new RecordBook());
    const invalidated = [];
    const installation = bindRecording(recorder, { failure, invalidate: (error) => invalidated.push(error) });
    let executions = 0;
    const node = new Node({
      run: (work) => {
        executions++;
        return work.input;
      },
    });
    const runner = new Runner(new Scene(node), new Resources(), undefined, { observations: [installation] }).build();
    const output = { content: 'completed before recording failed' };
    if (failure === 'isolate') assert.deepEqual(await runner.run(output), output);
    else
      await assert.rejects(runner.run(output), (error) => {
        const pending = [error];
        const visited = new Set();
        while (pending.length) {
          const current = pending.pop();
          if (current === cause) return true;
          if (!current || visited.has(current)) continue;
          visited.add(current);
          pending.push(current.cause, ...(current instanceof AggregateError ? current.errors : []));
        }
        return false;
      });
    assert.equal(executions, 1);
    assert.equal(rejectedWrites, 1);
    assert.ok(invalidated.length > 0);
    assert.equal(runner.isRunning, false);
  }
});
