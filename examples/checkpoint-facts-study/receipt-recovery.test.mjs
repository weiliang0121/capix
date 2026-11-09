import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Invocation, InvocationContext } from '@weiliang0121/capix-invocation';
import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';

const codec = { encode: (value) => value, decode: (value) => value };
const fixture = fileURLToPath(new URL('./receipt-process.mjs', import.meta.url));
const childKey = 'study.receipt.child';
function database(t) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-receipt-study-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'conversation.sqlite');
}
function run(mode, path, fault = 'none') {
  const childProcess = spawnSync(process.execPath, [fixture, mode, path, fault], { encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
  assert.ifError(childProcess.error);
  assert.ok(childProcess.stdout.trim(), childProcess.stderr);
  return { exitCode: childProcess.status, ...JSON.parse(childProcess.stdout) };
}
function count(value, kind) {
  return value.events.filter((event) => event.kind === kind).length;
}
function noRepeatedBusiness(before, after) {
  for (const kind of ['child-body', 'effect', 'accepted-mapping', 'handled-mapping']) assert.equal(count(after, kind), count(before, kind), kind);
}
function terminalRefused(before, after) {
  assert.equal(after.exitCode, 1, JSON.stringify(after));
  assert.match(after.error.message, /[Ff]inal|[Tt]erminal|[Ee]nded|[Cc]ompleted/);
  assert.deepEqual(after.root, before.root);
  assert.deepEqual(after.child, before.child);
  assert.deepEqual(after.events, before.events, 'terminal refusal must precede author execution and writes');
}

for (const fault of ['throw-before', 'throw-after', 'invalid-after']) {
  test(`Invocation ${fault}: finish failure is protected even with explicit parent handling`, async () => {
    const memory = new MemoryCheckpointStore();
    const counts = { body: 0, childFinish: 0, accepted: 0, handled: 0 };
    const failure = new Error('finish acknowledgement unavailable');
    const rootContext = new InvocationContext(null);
    const childContext = new InvocationContext(null);
    const childBinding = { key: childKey, version: 1, input: codec, output: codec, points: { completed: { state: codec, execute: () => assert.fail('no restore in live failure') } } };
    const store = {
      read: (id) => memory.read(id),
      save: (image, revision) => memory.save(image, revision),
      finish(id, revision, delivery) {
        if (id !== childContext.id) return memory.finish(id, revision, delivery);
        counts.childFinish++;
        if (fault === 'throw-before') throw failure;
        const receipt = memory.finish(id, revision, delivery);
        if (fault === 'throw-after') throw failure;
        return { ...receipt, revision: receipt.revision + 1 };
      },
    };
    const signal = new AbortController().signal;
    let relation;
    const root = new Invocation({
      context: rootContext,
      signal,
      identity: { contextId: rootContext.id, kind: 'scene' },
      checkpoints: { store },
      work: {
        checkpoint: { key: 'study.receipt.root', version: 1, input: codec, output: codec, children: [{ kind: 'node', binding: childBinding }], points: { waiting: { state: codec, execute: () => assert.fail('no live restore') } } },
        async execute(_context, invocation) {
          const child = new Invocation({
            context: childContext,
            signal,
            identity: { contextId: childContext.id, parentContextId: rootContext.id, kind: 'node' },
            parent: { invocation, declarationPosition: 0, receiveFailure: true },
            checkpoints: { store },
            work: {
              checkpoint: childBinding,
              execute(_childContext, childInvocation) {
                counts.body++;
                childInvocation.checkpointWriter.save('completed', { text: 'fixed result' });
                return { text: 'fixed result' };
              },
            },
          });
          relation = invocation.children.get(child);
          invocation.checkpointWriter.save('waiting', null);
          try {
            await child.run();
          } catch (error) {
            assert.equal(relation.returned.failure.receptionAllowed, false);
            await assert.rejects(relation.handle(() => counts.handled++));
            throw error;
          }
          return relation.accept(() => counts.accepted++);
        },
      },
    });
    await assert.rejects(root.run());
    assert.deepEqual(counts, { body: 1, childFinish: 1, accepted: 0, handled: 0 });
    assert.equal(childContext.status, 'succeeded', 'body output exists before required CP finish');
    assert.equal(relation.receiveFailure, true);
    assert.equal(relation.returned.status, 'failed');
    assert.equal(relation.returned.failure.receptionAllowed, false);
    assert.equal(relation.reception.status, 'pending');
    if (fault !== 'invalid-after') assert.equal(relation.returned.error, failure);
    const rootHead = memory.read(rootContext.id);
    assert.equal(rootHead.delivery.status, 'failed');
    assert.equal(rootHead.image.frame.children[0].state.kind, 'waiting', 'old image and terminal delivery are distinct');
    assert.equal(memory.read(childContext.id).delivery?.status, fault === 'throw-before' ? undefined : 'succeeded');
    assert.throws(() => memory.finish(rootContext.id, rootHead.revision, { status: 'succeeded', output: 'revived', progress: { round: 1, phase: 'execute', currentInput: null } }), /Final checkpoint delivery cannot advance/);
  });
}

for (const fault of ['throw-before', 'throw-after', 'invalid-after']) {
  test(`Runner ${fault}: normal unwind persists failed root and a fresh process cannot revive it`, (t) => {
    const path = database(t);
    const before = run('run', path, fault);
    assert.equal(before.exitCode, 1);
    assert.equal(before.root.delivery.status, 'failed');
    assert.equal(before.root.image.frame.children[0].state.kind, 'waiting');
    assert.equal(before.child.delivery?.status, fault === 'throw-before' ? undefined : 'succeeded');
    assert.equal(count(before, 'effect'), 1);
    assert.equal(count(before, 'accepted-mapping'), 0);
    assert.equal(count(before, 'handled-mapping'), 0);
    assert.deepEqual(
      before.events.filter((event) => event.kind === 'parent-relation').map(({ returned, reception }) => [returned, reception]),
      [['failed', 'pending']],
    );
    assert.equal(before.events.filter((event) => event.kind === 'finish-attempt' && event.contract === childKey).length, 1);
    terminalRefused(before, run('resume', path));
  });
}

for (const [fault, cut, restoredMode, childResume] of [
  ['exit-before', 'child-before-finish-commit', 'continuation', 1],
  ['exit-after', 'child-after-finish-commit', 'delivery', 0],
]) {
  test(`Runner process loss at ${cut}: resume ${restoredMode} without repeating child body or effect`, (t) => {
    const path = database(t);
    const before = run('run', path, fault);
    assert.equal(before.exitCode, 73);
    assert.equal(before.halted, cut);
    assert.equal(before.root.delivery, undefined);
    assert.equal(before.root.image.frame.children[0].state.kind, 'waiting');
    assert.equal(before.child.delivery?.status, restoredMode === 'delivery' ? 'succeeded' : undefined);
    const after = run('resume', path);
    assert.equal(after.exitCode, 0, JSON.stringify(after.error));
    assert.deepEqual(after.result, { answer: 'effect:one' });
    assert.equal(after.root.delivery.status, 'succeeded');
    assert.equal(after.root.image.frame.owner.contextId, before.root.image.frame.owner.contextId);
    assert.equal(after.child.image.frame.owner.contextId, before.child.image.frame.owner.contextId);
    assert.equal(after.child.delivery.status, 'succeeded');
    assert.equal(count(after, 'child-body'), 1);
    assert.equal(count(after, 'effect'), 1);
    assert.equal(count(after, 'child-resume'), childResume);
    assert.equal(count(after, 'accepted-mapping'), 1);
    assert.equal(count(after, 'handled-mapping'), 0);
    assert.deepEqual(
      after.events.filter((event) => event.kind === 'child-restored').map((event) => event.mode),
      [restoredMode],
    );
    assert.equal(after.root.image.frame.children[0].state.reception.kind, 'accepted');
    if (restoredMode === 'delivery') assert.deepEqual(after.child, before.child, 'reading terminal child does not issue another finish');
    terminalRefused(after, run('resume', path));
  });
}

test('Runner crash after effect but before first child CP: missing evidence refuses recovery without repeating the effect', (t) => {
  const path = database(t);
  const before = run('run', path, 'exit-effect');
  assert.equal(before.exitCode, 73);
  assert.equal(before.root.delivery, undefined);
  assert.equal(before.child, null);
  assert.equal(count(before, 'effect'), 1);
  const after = run('resume', path);
  assert.equal(after.exitCode, 1);
  assert.match(after.error.message, /no durable continuation; execution is unknown/);
  noRepeatedBusiness(before, after);
  assert.equal(count(after, 'child-resume'), 0);
  assert.equal(after.root.delivery.status, 'failed');
  assert.equal(after.child, null);
});

for (const mismatch of ['owner', 'input', 'contract']) {
  test(`Runner refuses durable child success with mismatched ${mismatch} evidence`, (t) => {
    const path = database(t);
    const before = run('run', path, 'exit-after');
    assert.equal(before.exitCode, 73);
    const after = run('resume', path, `mismatch-${mismatch}`);
    assert.equal(after.exitCode, 1);
    assert.match(after.error.message, /Child checkpoint differs from parent-owned identity/);
    assert.equal(count(after, 'changed-read'), 1);
    noRepeatedBusiness(before, after);
    assert.equal(count(after, 'child-resume'), 0);
    assert.deepEqual(after.child, before.child);
    assert.equal(after.root.delivery.status, 'failed');
  });
}

test('Runner process loss after protected child failure but before failed root commit: durable waiting can recover exact child success', (t) => {
  const path = database(t);
  const before = run('run', path, 'exit-before-root-failed');
  assert.equal(before.exitCode, 73);
  assert.equal(before.halted, 'root-before-failed-commit');
  assert.equal(before.root.delivery, undefined);
  assert.equal(before.root.image.frame.children[0].state.kind, 'waiting');
  assert.equal(before.child.delivery.status, 'succeeded');
  const failedReturn = before.events.find((event) => event.kind === 'failed-return');
  const rootWorkFinished = before.events.find((event) => event.kind === 'root-work-finished');
  const failedFinish = before.events.find((event) => event.kind === 'finish-attempt' && event.contract === 'study.receipt.root');
  assert.equal(failedReturn.receptionAllowed, false);
  assert.equal(failedReturn.contextId, before.root.image.frame.owner.contextId);
  assert.equal(rootWorkFinished.status, 'failed', 'the old parent really failed in memory before this process cut');
  assert.equal(failedFinish.status, 'failed');
  assert.ok(failedReturn.seq < rootWorkFinished.seq && rootWorkFinished.seq < failedFinish.seq);
  assert.equal(
    before.events.some((event) => event.kind === 'finish-committed' && event.contract === 'study.receipt.root'),
    false,
  );
  assert.deepEqual(
    before.events.filter((event) => event.kind === 'parent-relation').map(({ returned, reception }) => [returned, reception]),
    [['failed', 'pending']],
  );
  assert.equal(count(before, 'accepted-mapping'), 0);
  assert.equal(count(before, 'handled-mapping'), 0);

  const after = run('resume', path);
  assert.equal(after.exitCode, 0, JSON.stringify(after.error));
  assert.deepEqual(after.result, { answer: 'effect:one' });
  assert.equal(after.root.image.frame.owner.contextId, before.root.image.frame.owner.contextId);
  assert.equal(after.root.delivery.status, 'succeeded');
  assert.equal(after.root.image.frame.children[0].state.reception.kind, 'accepted');
  assert.deepEqual(after.child, before.child, 'exact durable child delivery is read without another finish');
  assert.equal(count(after, 'parent-body'), 1);
  assert.equal(count(after, 'parent-resume'), 1);
  assert.equal(count(after, 'child-body'), 1);
  assert.equal(count(after, 'effect'), 1);
  assert.equal(count(after, 'child-resume'), 0);
  assert.equal(count(after, 'accepted-mapping'), 1);
  assert.equal(count(after, 'handled-mapping'), 0);
  assert.deepEqual(
    after.events.filter((event) => event.kind === 'child-restored').map((event) => event.mode),
    ['delivery'],
  );
  assert.deepEqual(
    after.events.filter((event) => event.kind === 'root-work-finished').map((event) => event.status),
    ['failed'],
    'recovery uses its separate activity and does not rewrite or replay the old Invocation fact stream',
  );
  assert.deepEqual(
    after.events.filter((event) => event.kind === 'finish-committed' && event.contract === 'study.receipt.root').map((event) => event.status),
    ['succeeded'],
  );
  terminalRefused(after, run('resume', path));
});

test('Runner process loss after failed root commit: terminal failure remains authoritative without its receipt', (t) => {
  const path = database(t);
  const before = run('run', path, 'exit-root-failed');
  assert.equal(before.exitCode, 73);
  assert.equal(before.halted, 'root-after-failed-commit');
  assert.equal(before.root.delivery.status, 'failed');
  assert.equal(before.child.delivery.status, 'succeeded');
  assert.equal(count(before, 'handled-mapping'), 0);
  terminalRefused(before, run('resume', path));
});

test('Runner root success receipt failure: caller failure cannot replace durable success or authorize rerun', (t) => {
  const path = database(t);
  const before = run('run', path, 'throw-root-after');
  assert.equal(before.exitCode, 1);
  assert.match(before.error.message, /root finish acknowledgement unavailable/);
  assert.equal(before.root.delivery.status, 'succeeded');
  assert.equal(before.child.delivery.status, 'succeeded');
  assert.equal(before.root.image.frame.children[0].state.reception.kind, 'accepted');
  assert.equal(count(before, 'effect'), 1);
  assert.equal(count(before, 'accepted-mapping'), 1);
  assert.equal(before.events.filter((event) => event.kind === 'finish-attempt' && event.contract === 'study.receipt.root').length, 1);
  terminalRefused(before, run('resume', path));
});
