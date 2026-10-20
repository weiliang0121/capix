import test from 'node:test';
import assert from 'node:assert/strict';
import { ObservationReplica } from '@capix/client-runtime';
import { createDataProjection } from '../../apps/observer/.test-dist/binding/data.js';
import { createResponseProjection } from '../../apps/observer/.test-dist/binding/responses.js';
import { projectConversation } from '../../apps/observer/.test-dist/observation/conversation.js';
import { client, transport, submissionSnapshot } from '../client/fixtures.mjs';
import { observationFixture, observationState } from '../performance/observation.mjs';

const transcriptId = 'fixture-transcript';
const input = { transcriptId, start: 0, end: 1 };
const answer = { transcriptId, index: 1 };
const live = () => ({ id: 'current', queueId: 'queue', pending: 'question', feedback: { status: 'following' }, remote: submissionSnapshot('current', { input }), preview: { status: 'live', snapshot: { generation: 1, revision: 1, text: '', state: 'streaming' } } });

test('preview-only app frames do not revisit unchanged observation history or activity trees', (t) => {
  const { initial } = observationFixture(200, 0);
  const observation = observationState(ObservationReplica.receive(undefined, initial));
  const project = createDataProjection();
  const current = live();
  const calls = Array.from({ length: 512 }, (_, index) => ({ contextId: `call-${index}`, kind: 'group', label: '生成回答', status: index === 511 ? 'running' : 'succeeded', phase: 'execute', round: 1 }));
  current.remote = { ...current.remote, activities: { calls, integrity: { status: 'complete' } } };
  const state = { ...client({ conversation: transport() }).getSnapshot(), transcriptId, observation, submission: current, submissions: new Map([[current.id, current]]) };
  const first = project(state);
  const historicalUpdates = t.mock.method(observation.updates, Symbol.iterator, () => assert.fail('preview frame revisited record history'));
  calls.map = () => assert.fail('unchanged activity tree was reprojected');
  for (let index = 1; index <= 100; index++) {
    const submission = { ...current, preview: { status: 'live', snapshot: { generation: 1, revision: index + 1, text: '字'.repeat(index), state: 'streaming' } } };
    const next = project({ ...state, submission, submissions: new Map([[submission.id, submission]]) });
    assert.equal(next.rounds, first.rounds);
    assert.equal(next.graphs, first.graphs);
    assert.equal(next.details, first.details);
    assert.equal(next.conversation.at(-1).content.text.length, index);
  }
  assert.equal(historicalUpdates.mock.callCount(), 0);
});

test('response projection retains formal history while invalidating body and connection dependencies', () => {
  const project = createResponseProjection();
  const rows = Array.from({ length: 1000 }, (_, index) => ({ key: `message-${index}`, index, message: { role: index % 2 ? 'assistant' : 'user', content: `message ${index}` } }));
  const history = { ...live(), id: 'previous', queueId: 'previous-queue', preview: undefined, remote: submissionSnapshot('previous', { input, answer, result: { status: 'completed' } }) };
  const current = { ...live(), remote: submissionSnapshot('current', { input: { transcriptId, start: 998, end: 999 } }) };
  const state = {
    ...client({ conversation: transport() }).getSnapshot(),
    transcriptId,
    submission: current,
    submissions: new Map([
      [history.id, history],
      [current.id, current],
    ]),
  };
  const first = project(rows, state);
  const updated = { ...current, preview: { ...current.preview, snapshot: { ...current.preview.snapshot, revision: 2, text: 'preview' } } };
  const second = project(rows, {
    ...state,
    submission: updated,
    submissions: new Map([
      [history.id, history],
      [updated.id, updated],
    ]),
  });
  for (let index = 0; index < second.length; index++) {
    if (second[index].submissionId !== current.id) assert.equal(second[index], first[index]);
  }
  assert.equal(second.find((row) => row.submissionId === current.id).content.text, 'preview');
  const pending = { ...current, remote: { ...current.remote, answer: { transcriptId, index: 1000 } } };
  const pendingState = { ...state, submission: pending, submissions: new Map([[pending.id, pending]]) };
  assert.equal(project(rows, pendingState).find((row) => row.submissionId === pending.id).bodyState, 'unloaded');
  const failed = { ...pendingState, transcripts: new Map([[transcriptId, { sync: { status: 'failed' } }]]) };
  assert.equal(project(rows, failed).find((row) => row.submissionId === pending.id).bodyState, 'error');
  const body = { key: 'formal-answer', index: 1000, message: { role: 'assistant', content: 'formal' } };
  assert.equal(project([...rows, body], failed).find((row) => row.submissionId === pending.id).content.text, 'formal');
});

test('formal message links inspect each execution once and retain the earliest owner', () => {
  let inspected = 0;
  const executions = Array.from({ length: 1000 }, (_, index) => ({
    id: `execution-${index}`,
    get inputIndex() {
      inspected++;
      return index * 2;
    },
    response: { index: index * 2 + 1 },
  }));
  executions.push({ id: 'later-owner', inputIndex: 0, response: { index: 1 } });
  const messages = Array.from({ length: 2000 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: String(index) }));
  const rows = projectConversation(messages, { transcriptId, messages: [], executions }, transcriptId);
  assert.ok(inspected <= 2 * executions.length, `inspected ${inspected} execution inputs`);
  assert.equal(rows[0].executionId, 'execution-0');
  assert.equal(rows[1].executionId, 'execution-0');
  assert.equal(rows.at(-1).executionId, 'execution-999');
});
