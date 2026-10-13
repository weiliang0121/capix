import test from 'node:test';
import assert from 'node:assert/strict';
import { createResponseProjection } from '../../apps/observer/.test-dist/binding/responses.js';
import { createRevealProjection } from '../../apps/observer/.test-dist/binding/reveal.js';
import { TextReveal } from '../../apps/observer/.test-dist/presentation/text/reveal.js';
import { client, transport, submissionSnapshot } from '../client/fixtures.mjs';

const projectResponses = (messages, state) => createResponseProjection()(messages, state);

const input = { transcriptId: 'fixture-transcript', start: 0, end: 1 };
const answer = { transcriptId: input.transcriptId, index: 1 };
const user = { key: 'input', index: 0, message: { role: 'user', content: '问题' } };
const formal = { key: 'answer', index: 1, message: { role: 'assistant', content: '正式回答正文' }, reveal: true };
const snapshot = (patch = {}) => ({ generation: 1, revision: 1, text: '正式', state: 'streaming', ...patch });
function stateFor(preview, remote = {}, previewStatus = 'live') {
  const submission = { id: 'submission', queueId: 'local', pending: '问题', feedback: { status: 'following' }, remote: submissionSnapshot('submission', { input, ...remote }), preview: { status: previewStatus, snapshot: preview } };
  return { ...client({ conversation: transport() }).getSnapshot(), transcriptId: input.transcriptId, submission, submissions: new Map([[submission.id, submission]]), transcripts: new Map([[input.transcriptId, { sync: { status: 'live' } }]]) };
}
const project = (preview, remote = {}, rows = [user], previewStatus = 'live') => projectResponses(rows, stateFor(preview, remote, previewStatus));
const response = (...args) => project(...args).find((row) => row.kind === 'response');

test('preview is display content, never a formal message or accepted answer', () => {
  const rows = project(snapshot());
  const result = rows[1];
  assert.equal(rows.filter((row) => row.kind === 'message').length, 1);
  assert.equal(result.body, undefined);
  assert.equal(result.bodyState, 'unconfirmed');
  assert.deepEqual(result.content, { key: '["preview","submission",1]', text: '正式', complete: false, reveal: true, provisional: true });
  assert.equal(response(snapshot({ state: 'received' })).content.complete, false, 'stream completion still waits for acceptance');
});

test('formal locator and consistency retain the preview identity through an accepted prefix', () => {
  const playing = response(snapshot());
  const committed = snapshot({ state: 'committed', message: answer, consistency: 'prefix' });
  const waiting = response(committed, { answer, result: { status: 'completed' } });
  assert.equal(waiting.content.key, playing.content.key);
  assert.equal(waiting.content.complete, false, 'a partial prefix waits for the independently synchronized final body');
  const result = response(committed, { answer }, [user, formal]);
  assert.equal(result.content.key, playing.content.key);
  assert.equal(result.content.complete, true);
  assert.equal(result.content.provisional, false);
  assert.equal(result.body, formal);
  assert.equal(result.content.text, formal.message.content);
  const player = new TextReveal(playing.content);
  player.receive({ text: playing.content.text, complete: false });
  player.tick(0);
  player.tick(25);
  const visible = player.snapshot.text;
  player.receive({ text: result.content.text, complete: true });
  assert.equal(player.snapshot.text, visible, 'handoff cannot reset or jump the local display cursor');
});

test('a mismatched formal answer replaces the rejected preview visibly and without replay', () => {
  const result = response(snapshot({ state: 'committed', message: answer, consistency: 'mismatch' }), { answer }, [user, formal]);
  assert.equal(result.content.key, formal.key);
  assert.equal(result.content.reveal, false);
  assert.equal(result.content.text, formal.message.content);
  assert.match(result.notice.message, /正式接纳/);
});

test('a formal body already displayed before feedback arrives remains static', () => {
  const result = response(snapshot({ state: 'committed', text: formal.message.content, message: answer, consistency: 'complete' }), { answer }, [user, { ...formal, reveal: undefined }]);
  assert.equal(result.content.key, formal.key);
  assert.equal(result.content.reveal, false);
  assert.equal(project(snapshot({ state: 'committed', message: answer, consistency: 'complete' }), { answer }, [user, formal]).length, 2, 'locator consumes the formal row into one assistant region');
});

test('local formal text validates the published consistency before sharing a preview cursor', () => {
  for (const candidate of [snapshot({ state: 'committed', text: '不同正文', message: answer, consistency: 'prefix' }), snapshot({ state: 'committed', message: answer, consistency: 'complete' })]) {
    const result = response(candidate, { answer }, [user, formal]);
    assert.equal(result.content.key, formal.key);
    assert.equal(result.content.reveal, false);
    assert.match(result.notice.message, /正式接纳/);
  }
});

test('failed preview reception or mismatched scope cannot reuse a generation display cursor', () => {
  const candidate = snapshot({ state: 'committed', message: answer, consistency: 'prefix' });
  for (const status of ['failed', 'interrupted']) {
    const result = response(candidate, { answer }, [user, formal], status);
    assert.equal(result.content.key, formal.key);
    assert.equal(result.content.reveal, false);
  }
  for (const message of [
    { ...answer, transcriptId: 'another-transcript' },
    { ...answer, index: 5 },
  ]) {
    const result = response({ ...candidate, message }, { answer }, [user, formal]);
    assert.equal(result.content.key, formal.key);
    assert.equal(result.content.reveal, false);
  }
  assert.equal(project(candidate, {}, [user, formal], 'failed').filter((row) => row.kind === 'message').length, 2, 'untrusted preview scope cannot claim a formal row without an independent answer locator');
});

test('a committed preview locator joins the formal body before the answer feedback frame arrives', () => {
  const reveal = createRevealProjection();
  const initial = stateFor(undefined);
  reveal([], { ...initial, submission: undefined, submissions: new Map() });
  reveal([user], stateFor(snapshot()));
  const committed = snapshot({ state: 'committed', message: answer, consistency: 'prefix' });
  const state = stateFor(committed);
  const rows = reveal([user, { ...formal, reveal: undefined }], state);
  const result = projectResponses(rows, state);
  assert.equal(state.submission.remote.answer, undefined, 'binding does not fabricate submission facts');
  assert.equal(result.length, 2, 'formal content is consumed into one existing assistant region');
  assert.equal(result[1].content.key, '["preview","submission",1]');
  assert.equal(result[1].content.reveal, true);
  assert.equal(result[1].bodyState, 'available');
  assert.equal(result[1].body.message, formal.message);
});

test('without any locator formal content remains independently readable and is not guessed into a preview', () => {
  const rows = project(snapshot(), {}, [user, formal]);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].body, undefined);
  assert.equal(rows[2].kind, 'message');
  assert.equal(rows[2].message, formal.message);
});

test('opening a view during generation preserves the later preview-to-formal display handoff', () => {
  const reveal = createRevealProjection();
  reveal([user], stateFor(snapshot()));
  const state = stateFor(snapshot({ state: 'committed', message: answer, consistency: 'prefix' }));
  const result = projectResponses(reveal([user, { ...formal, reveal: undefined }], state), state)[1];
  assert.equal(result.content.key, '["preview","submission",1]');
  assert.equal(result.content.reveal, true);
});

test('new formal content waits for an explicit locator without flashing next to its preview', () => {
  const reveal = createRevealProjection();
  const initial = stateFor(undefined);
  reveal([], { ...initial, submission: undefined, submissions: new Map() });
  const generating = stateFor(snapshot());
  reveal([user], generating);
  const raw = [user, { ...formal, reveal: undefined }];
  const withheld = reveal(raw, generating);
  const first = projectResponses(withheld, generating);
  assert.equal(raw.length, 2, 'source messages are untouched');
  assert.equal(withheld.length, 1, 'unassociated new formal body is temporarily outside the display');
  assert.equal(first.length, 2);
  assert.equal(first[1].body, undefined);
  const committed = stateFor(snapshot({ state: 'committed', message: answer, consistency: 'prefix' }), { result: { status: 'completed' } });
  const final = projectResponses(reveal(raw, committed), committed);
  assert.equal(final.length, 2, 'only one assistant region exists after explicit handoff');
  assert.equal(final[1].body.message, formal.message);
  assert.equal(final[1].content.key, first[1].content.key);
  assert.equal(final[1].content.reveal, true, 'deferred content is not misclassified as already displayed history');
});

test('terminal or released tracking releases unassociated formal content statically', () => {
  for (const outcome of ['terminal', 'released', 'failed-preview']) {
    const reveal = createRevealProjection();
    const generating = stateFor(snapshot());
    reveal([user], generating);
    const raw = [user, { ...formal, reveal: undefined }];
    assert.equal(reveal(raw, generating).length, 1);
    const released = outcome === 'terminal' ? stateFor(snapshot(), { result: { status: 'completed' } }) : outcome === 'failed-preview' ? stateFor(snapshot(), {}, 'failed') : { ...generating, submission: undefined, submissions: new Map() };
    const result = reveal(raw, released);
    assert.equal(result.length, 2, `${outcome} cannot withhold formal messages`);
    assert.equal(result[1].reveal, undefined, 'without explicit association the formal message is static');
  }
});

test('preexisting history and assistant messages inside the accepted input range are never deferred', () => {
  const reveal = createRevealProjection();
  const rows = [user, { ...formal, reveal: undefined }];
  assert.equal(reveal(rows, stateFor(snapshot())).length, 2, 'initial history is already readable');
  const imported = createRevealProjection();
  const state = stateFor(snapshot(), { input: { ...input, end: 3 } });
  imported([], { ...state, submission: undefined, submissions: new Map() });
  const messages = [...rows, { ...user, key: 'new-input', index: 2 }];
  assert.equal(imported(messages, state).length, 3, 'formal imported history belongs to the accepted input range');
});

test('unexpected unassociated volume falls back to readable formal content within a fixed buffer bound', () => {
  const reveal = createRevealProjection();
  const state = stateFor(snapshot());
  reveal([user], state);
  const rows = [user, ...Array.from({ length: 33 }, (_, offset) => ({ key: `formal-${offset}`, index: offset + 1, message: { role: 'assistant', content: `formal-${offset}` } }))];
  assert.equal(reveal(rows, state).length, rows.length, 'overflow releases the entire display buffer');
  const next = [...rows, { key: 'after-overflow', index: 34, message: { role: 'assistant', content: 'more' } }];
  assert.equal(reveal(next, state).length, next.length, 'same submission does not begin withholding again after overflow');
});

test('generation replacement never shares a previous preview display cursor', () => {
  const first = response(snapshot());
  const retry = response(snapshot({ generation: 2, text: '重新生成' }));
  assert.equal(first.key, retry.key, 'same local response region');
  assert.notEqual(first.content.key, retry.content.key, 'independent generation text');
  assert.equal(retry.content.text, '重新生成');
});

test('cancelled or rejected partial content remains explicitly unaccepted and can finish displaying', () => {
  for (const reason of ['cancelled', 'rejected', 'failed']) {
    const result = response(snapshot({ state: 'discarded', reason }));
    assert.equal(result.content.text, '正式');
    assert.equal(result.content.complete, true);
    assert.equal(result.content.provisional, true);
    assert.equal(result.body, undefined);
    assert.match(result.notice.message, /未.*正式回答/);
  }
});

test('preview connection failures preserve text without manufacturing a submission outcome', () => {
  for (const status of ['interrupted', 'failed']) {
    const result = response(snapshot(), {}, [user], status);
    assert.equal(result.content.text, '正式');
    assert.equal(result.content.complete, false);
    assert.equal(result.bodyState, 'unconfirmed');
    assert.match(result.notice.message, /预览/);
  }
  const final = response(snapshot(), { result: { status: 'failed', error: { code: 'MODEL', message: 'internal' } } }, [user], 'failed');
  assert.equal(final.content.complete, true, 'a confirmed terminal result cannot leave the local display waiting forever');
  assert.doesNotMatch(final.notice.message, /internal/);
});
