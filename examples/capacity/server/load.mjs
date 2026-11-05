import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay, setImmediate as yieldTurn } from 'node:timers/promises';
import { ClientSubmission } from '@capix/client-runtime';
import { distribution } from '../measurement.mjs';
import { expectedAnswer } from '../upstream-client.mjs';

const maximumFrameBytes = 2 * 1024 * 1024;
const maximumResponseBytes = 64 * 1024 * 1024;

/**
 * Open-loop arrivals: a slow response never postpones the next request. A fixed
 * round-robin mapping also leaves real per-conversation busy rejections visible.
 * This module runs in the load process, separately from service and model workers.
 */
export async function runLoad({ sessions, rate, durationSeconds, timeoutMs = 60_000, outputBytes = 2048, pattern = 'steady' }) {
  validate({ sessions, rate, durationSeconds, timeoutMs, outputBytes, pattern });
  // Worker readiness commonly arrives in batches. Sorting prevents a batch of
  // ports from one worker receiving all early traffic in a sharded experiment.
  sessions = [...sessions].sort((left, right) => left.index - right.index);
  const total = pattern === 'burst' ? sessions.length : Math.ceil(rate * durationSeconds);
  const arrivalMs = pattern === 'burst' ? 0 : durationSeconds * 1000;
  const rows = [];
  const pending = [];
  const turns = new Map();
  const started = performance.now();
  let active = 0;
  let peakActive = 0;

  for (let index = 0; index < total; index++) {
    const scheduledOffsetMs = pattern === 'burst' ? 0 : (index * 1000) / rate;
    const due = started + scheduledOffsetMs;
    // Node timers may truncate a fractional delay. Recheck the absolute target
    // after waking so a request is never dispatched before its scheduled arrival.
    if (performance.now() >= due && index && index % 64 === 0) await yieldTurn();
    while (performance.now() < due) await delay(due - performance.now());
    const session = sessions[index % sessions.length];
    const turn = (turns.get(session.index) ?? 0) + 1;
    turns.set(session.index, turn);
    const submissionId = randomUUID();
    const query = JSON.stringify({ session: session.index, turn, nonce: submissionId });
    const row = {
      index,
      session: session.index,
      conversationId: session.conversationId,
      submissionId,
      query,
      scheduledOffsetMs,
      dispatchedOffsetMs: performance.now() - started,
      firstDeltaMs: null,
      firstDeltaSource: null,
      responseBytes: 0,
      frames: 0,
      status: 'pending',
      correctPreview: false,
      committed: false,
    };
    row.schedulerDelayMs = Math.max(0, row.dispatchedOffsetMs - scheduledOffsetMs);
    rows.push(row);
    active++;
    peakActive = Math.max(peakActive, active);
    pending.push(
      submit(session, row, timeoutMs, outputBytes, started).finally(() => {
        active--;
      }),
    );
  }
  const dispatchFinishedMs = performance.now() - started;
  // Preserve the configured arrival window even when the final request returns early.
  const rest = started + arrivalMs - performance.now();
  if (rest > 0) await delay(rest);
  await Promise.all(pending);
  const elapsedMs = performance.now() - started;
  const succeeded = rows.filter((row) => row.status === 'succeeded');
  const rejected = rows.filter((row) => row.status === 'rejected');
  const failures = {};
  for (const row of rows) {
    if (row.status !== 'succeeded') failures[row.code ?? row.status] = (failures[row.code ?? row.status] ?? 0) + 1;
  }
  return {
    rows,
    workload: {
      pattern,
      offered: total,
      succeeded: succeeded.length,
      rejected: rejected.length,
      failed: total - succeeded.length - rejected.length,
      peakActive,
      arrivalMs,
      dispatchFinishedMs,
      elapsedMs,
      drainMs: Math.max(0, elapsedMs - arrivalMs),
      completedDuringArrival: rows.filter((row) => row.completedOffsetMs <= arrivalMs).length,
      succeededDuringArrival: succeeded.filter((row) => row.completedOffsetMs <= arrivalMs).length,
      outstandingAtArrivalEnd: rows.filter((row) => row.scheduledOffsetMs <= arrivalMs && row.completedOffsetMs > arrivalMs).length,
      successPerSecondIncludingDrain: (succeeded.length * 1000) / elapsedMs,
      successPerSecondDuringArrival: arrivalMs ? (succeeded.filter((row) => row.completedOffsetMs <= arrivalMs).length * 1000) / arrivalMs : null,
    },
    // Successful rows define service latency. Failed/rejected latency is separately
    // available so quick busy responses cannot make an overloaded case look fast.
    latencyMs: {
      completion: distribution(succeeded.map((row) => row.completionMs)),
      firstDelta: distribution(succeeded.map((row) => row.firstDeltaMs)),
      scheduledCompletion: distribution(succeeded.map((row) => row.scheduledCompletionMs)),
      scheduledFirstDelta: distribution(succeeded.map((row) => row.firstDeltaMs + row.schedulerDelayMs)),
      schedulerDelay: distribution(rows.map((row) => row.schedulerDelayMs)),
      allCompletion: distribution(rows.map((row) => row.completionMs)),
    },
    buckets: buckets(rows, Math.max(arrivalMs, elapsedMs)),
    failures,
    wire: { responseBytes: rows.reduce((sum, row) => sum + row.responseBytes, 0), frames: rows.reduce((sum, row) => sum + row.frames, 0) },
  };
}

async function submit(session, row, timeoutMs, outputBytes, start) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Capacity feedback deadline elapsed')), timeoutMs);
  const receiver = ClientSubmission.attach({ conversationId: session.conversationId, submissionId: row.submissionId }, session.conversationId);
  let phase = 'network';
  let response;
  let reader;
  let reachedEnd = false;
  try {
    response = await fetch(`${session.origin}/api/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: session.origin },
      body: JSON.stringify({ conversationId: session.conversationId, submissionId: row.submissionId, input: { messages: [{ role: 'user', content: row.query }] } }),
      signal: controller.signal,
    });
    row.httpStatus = response.status;
    if (response.status !== 200) {
      // This is not a business rejection returned in a valid 200 feedback stream.
      throw failure(`HTTP_${response.status}`, `HTTP submission returned ${response.status}`);
    }
    if (!response.headers.get('content-type')?.startsWith('application/x-ndjson')) throw failure('INVALID_CONTENT_TYPE', 'Expected NDJSON submission feedback');
    if (!response.body) throw failure('MISSING_BODY', 'Submission feedback has no body');
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffered = '';
    let reading = true;
    const accept = (line) => {
      if (!line.trim()) return;
      if (Buffer.byteLength(line) > maximumFrameBytes) throw failure('FRAME_LIMIT', 'Submission frame exceeded the test receiver limit');
      phase = 'protocol';
      const frame = JSON.parse(line);
      receiver.receiveFrame(frame);
      row.frames++;
      const preview = receiver.snapshot.preview;
      // A later coalesced baseline may repair a gap. Retain the first observable
      // text time, but require a complete, consistent final replica below.
      if (preview?.snapshot?.text && row.firstDeltaMs === null) {
        row.firstDeltaMs = performance.now() - start - row.dispatchedOffsetMs;
        row.firstDeltaSource = frame.type === 'baseline' ? 'baseline' : 'delta';
      }
      phase = 'network';
    };
    while (reading) {
      const part = await reader.read();
      if (part.done) {
        buffered += decoder.decode();
        reading = false;
        reachedEnd = true;
      } else {
        row.responseBytes += part.value.byteLength;
        if (row.responseBytes > maximumResponseBytes) throw failure('RESPONSE_LIMIT', 'Submission feedback exceeded the test receiver limit');
        buffered += decoder.decode(part.value, { stream: true });
      }
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        accept(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
      }
      if (Buffer.byteLength(buffered) > maximumFrameBytes) throw failure('FRAME_LIMIT', 'Unterminated submission frame exceeded the test receiver limit');
    }
    if (buffered.trim()) throw failure('INCOMPLETE_FRAME', 'Submission ended with an unterminated frame');
    controller.signal.throwIfAborted();
    const state = receiver.snapshot;
    const remote = state.remote;
    row.remoteStatus = remote?.result?.status ?? null;
    row.inputIndex = remote?.input?.start ?? null;
    row.answerIndex = remote?.answer?.index ?? null;
    if (remote?.integrity.status !== 'complete') throw failure('INCOMPLETE_FEEDBACK', 'Submission feedback is missing or incomplete');
    if (!remote.result) throw failure('MISSING_RESULT', 'Submission ended without a terminal result');
    if (remote.result.status === 'rejected') {
      row.status = 'rejected';
      row.code = remote.result.error.code;
      return;
    }
    if (remote.result.status !== 'completed') throw failure(remote.result.error?.code ?? `TERMINAL_${remote.result.status.toUpperCase()}`, 'Submission did not complete');
    if (!remote.input || !remote.answer || remote.answer.transcriptId !== session.conversationId) throw failure('MISSING_FORMAL_ANSWER', 'Completed submission did not identify its formal answer');
    const preview = state.preview;
    const value = preview?.snapshot;
    row.committed = preview?.status === 'live' && value?.state === 'committed' && value.consistency === 'complete';
    row.correctPreview = value?.text === expectedAnswer(row.query, outputBytes);
    if (!row.committed || value.message?.transcriptId !== remote.answer.transcriptId || value.message?.index !== remote.answer.index) throw failure('PREVIEW_NOT_COMMITTED', 'Expected a complete preview committed to the formal answer');
    if (!row.correctPreview) throw failure('PREVIEW_MISMATCH', 'Preview differs from this request exact fixture answer');
    row.status = 'succeeded';
  } catch (error) {
    row.status = 'failed';
    row.code = controller.signal.aborted ? 'FEEDBACK_TIMEOUT' : typeof error?.code === 'string' ? error.code : phase === 'protocol' ? 'FEEDBACK_CONTRACT' : 'NETWORK';
    row.error = error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400);
  } finally {
    clearTimeout(timeout);
    // Cancelling this reader only disconnects feedback. The independent server
    // submission must still be joined by the server host at experiment shutdown.
    if (reader) {
      if (!reachedEnd) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    } else if (response?.body) await response.body.cancel().catch(() => undefined);
    row.completedOffsetMs = performance.now() - start;
    row.completionMs = row.completedOffsetMs - row.dispatchedOffsetMs;
    row.scheduledCompletionMs = row.completedOffsetMs - row.scheduledOffsetMs;
  }
}

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function buckets(rows, elapsedMs) {
  const width = 5000;
  const result = [];
  for (let startMs = 0; startMs < elapsedMs; startMs += width) {
    const endMs = Math.min(startMs + width, elapsedMs);
    const ended = rows.filter((row) => row.completedOffsetMs >= startMs && row.completedOffsetMs < endMs);
    result.push({
      startMs,
      endMs,
      scheduled: rows.filter((row) => row.scheduledOffsetMs >= startMs && row.scheduledOffsetMs < endMs).length,
      dispatched: rows.filter((row) => row.dispatchedOffsetMs >= startMs && row.dispatchedOffsetMs < endMs).length,
      completed: ended.length,
      succeeded: ended.filter((row) => row.status === 'succeeded').length,
      rejected: ended.filter((row) => row.status === 'rejected').length,
      failed: ended.filter((row) => row.status === 'failed').length,
      inFlightAtEnd: rows.filter((row) => row.dispatchedOffsetMs < endMs && row.completedOffsetMs >= endMs).length,
      scheduledOutstandingAtEnd: rows.filter((row) => row.scheduledOffsetMs < endMs && row.completedOffsetMs >= endMs).length,
      completionMs: distribution(ended.filter((row) => row.status === 'succeeded').map((row) => row.completionMs)),
    });
  }
  return result;
}

function validate({ sessions, rate, durationSeconds, timeoutMs, outputBytes, pattern }) {
  if (!Array.isArray(sessions) || !sessions.length || sessions.length > 1000) throw new TypeError('Load requires 1..1000 fixed sessions');
  const seen = new Set();
  for (const session of sessions) {
    const origin = new URL(session.origin);
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.origin !== session.origin || !origin.port) throw new TypeError('Capacity endpoints must be explicit loopback HTTP origins');
    if (!Number.isSafeInteger(session.index) || session.index < 0 || seen.has(session.index) || typeof session.conversationId !== 'string' || !session.conversationId) throw new TypeError('Capacity sessions require unique nonnegative indices and conversation IDs');
    seen.add(session.index);
  }
  if (!['steady', 'burst'].includes(pattern)) throw new TypeError('Unknown capacity load pattern');
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1000) throw new RangeError('Capacity arrival rate must be within (0, 1000]');
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 600 || rate * durationSeconds > 30_000) throw new RangeError('Capacity duration/count exceeds the experiment bound');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 180_000) throw new RangeError('Capacity feedback timeout must be within 100..180000 ms');
  if (!Number.isSafeInteger(outputBytes) || outputBytes < 128 || outputBytes > 1024 * 1024) throw new RangeError('Capacity output bytes must be within 128..1048576');
}
