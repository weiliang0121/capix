import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ToolStages } from '@capix/conversation-service/tools/hosting';

function fixture() {
  let receiver;
  let closed = 0;
  const stages = new ToolStages(
    {
      subscribe(value) {
        receiver = value;
        return () => closed++;
      },
    },
    { id: 'loop', stages: { model: 'model', tools: [{ structureId: 'reader', name: 'read_message' }] } },
  );
  const events = [];
  stages.subscribe({
    receive(event) {
      events.push(event);
    },
  });
  const send = (entryId, source, fact) => receiver.receive({ runnerId: 'runner', entryId, source, fact });
  const entry = (id, kind) => send(id, 'entry', { kind, sequence: 1, occurredAt: '2026-11-06T00:00:00Z' });
  const fact = (contextId, structureId, parentContextId, change = { kind: 'started' }) => ({ identity: { contextId, kind: 'group', ...(parentContextId ? { parentContextId } : {}) }, description: { id: structureId, name: 'misleading display name' }, eventSequence: 1, occurredAt: '2026-11-06T00:00:00Z', ...change });
  return { stages, events, send, entry, fact, closed: () => closed };
}

test('tool stages use exact structures and direct call ownership, without recording or duplicate start events', () => {
  const f = fixture();
  f.entry('one', 'acquired');
  f.send('one', 'invocation', f.fact('loop-call', 'loop', 'answer-call'));
  f.send('one', 'invocation', f.fact('nested', 'reader', 'other-parent'));
  f.send('one', 'invocation', f.fact('lookalike', 'wrong-id', 'loop-call'));
  f.send('one', 'invocation', f.fact('model-call', 'model', 'loop-call'));
  f.send('one', 'invocation', f.fact('model-call', 'model', 'loop-call', { kind: 'process', action: 'start', stage: 'execute', round: 1 }));
  f.send('one', 'invocation', f.fact('model-call', 'model', 'loop-call', { kind: 'finished', status: 'succeeded' }));
  f.send('one', 'invocation', f.fact('tool-call', 'reader', 'loop-call'));
  f.send('one', 'invocation', f.fact('tool-call', 'reader', 'loop-call', { kind: 'finished', status: 'failed' }));
  assert.deepEqual(
    f.events.map(({ stage }) => [stage.kind, stage.label, stage.status]),
    [
      ['model', '模型处理', 'running'],
      ['model', '模型处理', 'succeeded'],
      ['tool', 'read_message', 'running'],
      ['tool', 'read_message', 'failed'],
    ],
  );
  assert.ok(f.events.every((event) => Object.isFrozen(event) && Object.isFrozen(event.stage)));
  assert.ok(!JSON.stringify(f.events).includes('misleading'));
  f.stages.close();
  f.stages.close();
  assert.equal(f.closed(), 1);
});

test('restored baselines never become stages; newly resumed activity does and an old entry release cannot erase a new entry', () => {
  const f = fixture();
  f.entry('old', 'acquired');
  f.send('old', 'checkpoint', { kind: 'installed', owner: { contextId: 'loop-call' }, baseline: { childCount: 2 } });
  f.send('old', 'checkpoint', { kind: 'child-restored', mode: 'delivery', child: { identity: { contextId: 'old-model' }, state: 'returned' } });
  assert.equal(f.events.length, 0);
  f.send('old', 'checkpoint', { kind: 'activity', fact: f.fact('loop-call', 'loop', 'answer-call', { kind: 'process', action: 'start', stage: 'execute', round: 1 }) });
  f.send('old', 'checkpoint', { kind: 'activity', fact: f.fact('resumed-model', 'model', 'loop-call', { kind: 'process', action: 'start', stage: 'execute', round: 1 }) });
  assert.equal(f.events.length, 1);
  f.entry('new', 'acquired');
  f.send('new', 'invocation', f.fact('new-loop', 'loop', 'new-answer'));
  f.entry('old', 'released');
  f.send('old', 'invocation', f.fact('late-old', 'reader', 'loop-call'));
  f.send('new', 'invocation', f.fact('new-tool', 'reader', 'new-loop'));
  assert.deepEqual(
    f.events.map(({ entryId, stage }) => [entryId, stage.contextId]),
    [
      ['old', 'resumed-model'],
      ['new', 'new-tool'],
    ],
  );
  f.stages.close();
});

test('a broken stage subscriber is isolated from other consumers and later work', () => {
  const f = fixture();
  let attempts = 0;
  let failures = 0;
  f.stages.subscribe({
    receive() {
      attempts++;
      throw new Error('viewer closed');
    },
    failed() {
      failures++;
    },
  });
  f.entry('one', 'acquired');
  f.send('one', 'invocation', f.fact('loop-call', 'loop', 'root'));
  f.send('one', 'invocation', f.fact('model-call', 'model', 'loop-call'));
  f.send('one', 'invocation', f.fact('model-call', 'model', 'loop-call', { kind: 'finished', status: 'succeeded' }));
  assert.equal(attempts, 1);
  assert.equal(failures, 1);
  assert.equal(f.events.length, 2);
  f.stages.close();
});
