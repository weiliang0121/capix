import assert from 'node:assert/strict';

/** Test-side wire reconstruction; client acceptance is covered separately by its real receiver. */
export function submissionSnapshot(frame, previous) {
  if (frame.type === 'baseline') return frame.submission;
  assert.equal(frame.type, 'submission');
  assert.ok(previous, 'an update needs a baseline');
  assert.equal(frame.submissionId, previous.submissionId);
  assert.equal(frame.conversationId, previous.conversationId);
  if (frame.revision <= previous.revision) return previous;
  assert.ok(frame.fromRevision <= previous.revision);
  const { executions, activities, admission, ...fields } = frame.change;
  const next = { ...previous, ...fields, revision: frame.revision };
  if (executions) next.executions = [...previous.executions, ...executions.filter((item) => !previous.executions.some((existing) => existing.contextId === item.contextId))];
  if (activities) {
    const calls = new Map(previous.activities?.calls.map((call) => [call.contextId, call]));
    for (const call of activities.calls ?? []) calls.set(call.contextId, call);
    next.activities = { calls: [...calls.values()], integrity: activities.integrity ?? previous.activities?.integrity };
  }
  if (admission === null) delete next.admission;
  else if (admission !== undefined) next.admission = admission;
  return next;
}

export function submissionSnapshots(frames) {
  let current;
  return frames.filter((frame) => frame.type !== 'answer').map((frame) => (current = submissionSnapshot(frame, current)));
}
