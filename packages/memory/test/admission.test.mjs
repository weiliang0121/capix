import assert from 'node:assert/strict';

import { test } from 'node:test';

import { ChangeBuffer } from '@weiliang0121/capix-changes';

import { Memories, Memory } from '@weiliang0121/capix-memory';

import { Transcript } from '@weiliang0121/capix-transcript';

const create = (content) => ({ action: 'create', memoryId: null, change: 'retain evidence', sourceIndexes: [0], result: { topic: 'topic', content, sourceIndexes: [0] } });

const fixed = (memories, changes) => ({ contract: { key: 'memories.apply', version: 1 }, operation: { contextId: 'applying-call', position: 'memory' }, memoriesId: memories.id, changes });

for (const method of ['apply', 'applyFixed']) {
  const apply = (memories, changes) => memories[method](method === 'apply' ? changes : fixed(memories, changes));

  test(`${method} fixes each proposal before a later proposal getter can rewrite its event evidence`, () => {
    const events = new ChangeBuffer();
    const commits = [];
    const transcript = new Transcript([{ role: 'user', content: 'evidence' }]);
    const memories = new Memories(transcript, {
      changes: events,
      persistence: {
        commit(value) {
          commits.push(value);
        },
      },
    });
    const first = create('first');
    const accepted = structuredClone(first);
    const second = create('second');
    const secondResult = second.result;
    Object.defineProperty(second, 'result', {
      get() {
        first.action = 'update';
        first.memoryId = 'foreign';
        first.change = 'rewritten';
        first.sourceIndexes[0] = 99;
        first.result.content = 'rewritten';
        first.result.sourceIndexes[0] = 99;
        return secondResult;
      },
    });

    const result = apply(memories, [first, second]);
    const [event, next] = events.take();
    const [memory, following] = memories.values();
    assert.equal(memories.sequence, 2);
    assert.equal(commits.length, 1);
    assert.deepEqual(event.change, { action: accepted.action, memoryId: memory.id, explanation: accepted.change, sourceIndexes: accepted.sourceIndexes, result: accepted.result });
    assert.deepEqual(memory.snapshot(), accepted.result);
    assert.deepEqual(commits[0].upserts[0], { id: memory.id, ...accepted.result });
    assert.deepEqual(next.change.result, secondResult);
    if (method === 'apply') {
      assert.equal(result[0], memory);
      assert.equal(result[1], following);
    } else {
      const replay = fixed(memories, [accepted, { ...second, result: secondResult }]);
      assert.deepEqual(commits[0].fixed.request.changes[0], accepted);
      assert.equal(memories.applyFixed(replay), result);
      assert.deepEqual(Memories.restore(memories.exportState(), transcript).confirmFixed(replay), result);
      assert.equal(commits.length, 1);
      assert.deepEqual(events.take(), []);
    }
  });

  test(`${method} fixes explanation and evidence before reading the result getter`, () => {
    const events = new ChangeBuffer();
    const memories = new Memories(new Transcript([{ role: 'user', content: 'evidence' }]), { changes: events });
    const proposal = create('accepted');
    const result = proposal.result;
    Object.defineProperty(proposal, 'result', {
      get() {
        proposal.change = 'rewritten';
        proposal.sourceIndexes[0] = 99;
        return result;
      },
    });

    apply(memories, [proposal, create('next')]);
    const [event] = events.take();
    assert.equal(event.change.explanation, 'retain evidence');
    assert.deepEqual(event.change.sourceIndexes, [0]);
    assert.deepEqual(event.change.result.sourceIndexes, [0]);
  });

  test(`${method} keeps content and source indexes fixed while reading optional result sources`, () => {
    const events = new ChangeBuffer();
    const memories = new Memories(new Transcript([{ role: 'user', content: 'evidence' }]), { changes: events });
    const proposal = create('accepted');
    Object.defineProperty(proposal.result, 'sourceResults', {
      get() {
        proposal.result.topic = '';
        proposal.result.content = '';
        proposal.result.sourceIndexes[0] = 99;
        return undefined;
      },
    });

    apply(memories, [proposal, create('next')]);
    assert.deepEqual(memories.values()[0].snapshot(), { topic: 'topic', content: 'accepted', sourceIndexes: [0] });
    assert.deepEqual(events.take()[0].change.result, memories.values()[0].snapshot());
  });

  test(`${method} rejects a later invalid proposal without persisting or publishing any of the batch`, () => {
    const events = new ChangeBuffer();
    const commits = [];
    const memories = new Memories(new Transcript([{ role: 'user', content: 'evidence' }]), {
      changes: events,
      persistence: {
        commit(value) {
          commits.push(value);
        },
      },
    });
    const first = create('first');
    const invalid = create('invalid');
    Object.defineProperty(invalid, 'result', {
      get() {
        first.sourceIndexes[0] = 99;
        return { topic: 'invalid', content: 'invalid', sourceIndexes: [99] };
      },
    });

    assert.throws(() => apply(memories, [first, invalid]));
    assert.equal(memories.sequence, 0);
    assert.deepEqual(memories.values(), []);
    assert.deepEqual(commits, []);
    assert.deepEqual(events.take(), []);
    assert.equal(memories.exportState().applies, undefined);
  });
}

test('fixed memory application captures its operation before reading changes', () => {
  const events = new ChangeBuffer();
  const memories = new Memories(new Transcript([{ role: 'user', content: 'evidence' }]), { changes: events });
  const changes = [create('accepted')];
  const request = () => {
    const value = fixed(memories, changes);
    Object.defineProperty(value, 'changes', {
      get() {
        value.operation.contextId = 'rewritten';
        value.operation.position = '';
        return changes;
      },
    });
    return value;
  };

  const receipt = memories.applyFixed(request());
  assert.equal(memories.confirmFixed(request()), receipt);
  assert.equal(memories.applyFixed(fixed(memories, changes)), receipt);
  assert.deepEqual(memories.exportState().applies[0].request.operation, { contextId: 'applying-call', position: 'memory' });
  assert.equal(memories.sequence, 1);
  assert.equal(events.take().length, 1);
});

test('memory result sources keep their validated identity and receipt while reading later fields', () => {
  const transcript = new Transcript([
    { role: 'user', content: 'request' },
    { role: 'assistant', content: 'answer' },
  ]);
  const source = { id: 'file-result', kind: 'file-created', answerIndex: 1, receipt: { path: 'answer.md', bytes: 12 } };
  Object.defineProperty(source.receipt, 'digest', {
    get() {
      source.id = '';
      source.kind = 'rewritten';
      source.answerIndex = 99;
      source.receipt.path = '';
      source.receipt.bytes = -1;
      return 'a'.repeat(64);
    },
  });

  const memory = new Memory(transcript, { topic: 'topic', content: 'accepted', sourceIndexes: [0], sourceResults: [source] });
  assert.deepEqual(memory.sourceResults, [{ id: 'file-result', kind: 'file-created', answerIndex: 1, receipt: { path: 'answer.md', bytes: 12, digest: 'a'.repeat(64) } }]);
});
