import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { ChatCompletionsProvider } from '@capix/model-provider';
import { createCapacitySession, measureStorage } from './assembly.mjs';
import { startUpstream, expectedAnswer } from './upstream-client.mjs';
import { measureProcess, modelMeter, distribution } from './measurement.mjs';
import { validateCase } from './plan.mjs';

// Each suite case has its own process, heap, sockets and model simulator.
const directory = process.argv[2];
if (!directory || process.argv.length !== 3) throw new Error('worker requires one experiment directory');
const config = validateCase(JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8')));
const sessions = [];
const running = new Set();
const rows = [];
const model = await startUpstream(config.model);
const provider = new ChatCompletionsProvider({ endpoint: model.endpoint, apiKey: 'offline-capacity-fixture', model: 'capacity-model', timeoutMs: 60_000 });
const meter = modelMeter(provider);
let active = 0;
let peakActive = 0;
let acquiredActive = 0;
let peakAcquired = 0;
const observerFailures = [];
let measurement;
let building;
let failure;
const summary = { config, scope: 'in-process independent conversations; real loopback model HTTP; not a multi-user HTTP application' };

try {
  globalThis.gc?.();
  building = measureProcess();
  for (let index = 0; index < config.users; index++) {
    const session = createCapacitySession({ index, model: meter.model, directory, profile: config.profile, historyBytes: config.historyBytes });
    const entries = new Map();
    session.entries = entries;
    session.next = undefined;
    session.turn = 0;
    session.subscriptions = [
      session.runner.observation.subscribe({
        receive(event) {
          if (event.source !== 'entry') return;
          if (event.fact.kind === 'requested') {
            assert.ok(session.next, 'entry must match an actual scheduled submission');
            entries.set(event.entryId, session.next);
            session.next = undefined;
          }
          const row = entries.get(event.entryId);
          if (!row) return;
          if (event.fact.kind === 'acquired') {
            row.acquiredMs = performance.now() - row.started;
            acquiredActive++;
            peakAcquired = Math.max(peakAcquired, acquiredActive);
          }
          if (event.fact.kind === 'released') acquiredActive--;
          if (event.fact.kind === 'rejected') row.rejected = event.fact.reason;
          if (event.fact.kind === 'attached') row.attachedMs = performance.now() - row.started;
        },
        failed: (error) => {
          observerFailures.push(error);
        },
      }),
      session.runner.output.subscribe({
        receive(event) {
          const row = entries.get(event.entryId);
          if (!row || event.kind !== 'delta') return;
          row.firstDeltaMs ??= performance.now() - row.started;
          row.preview += event.delta;
          row.deltaCount++;
          if (row.cancel && !row.cancelRequested) {
            row.cancelRequested = true;
            queueMicrotask(() => session.runner.cancel());
          }
        },
        failed: (error) => {
          observerFailures.push(error);
        },
      }),
    ];
    sessions.push(session);
  }
  summary.build = building.stop();
  building = undefined;
  measurement = measureProcess();
  await delay(20); // Arm its sampler before a synchronous burst can block the loop.
  measurement.reset();
  const began = performance.now();

  function submit(index, scheduled) {
    const session = sessions[index];
    const started = performance.now();
    const query = JSON.stringify({ session: index, turn: ++session.turn, nonce: `${config.name}:${rows.length}` });
    const row = { sequence: rows.length, session: index, scheduledMs: scheduled - began, startedMs: started - began, schedulerDelayMs: Math.max(0, started - scheduled), started, acquiredMs: null, attachedMs: null, firstDeltaMs: null, deltaCount: 0, preview: '', cancel: config.pattern === 'churn' && index % 5 === 0 };
    rows.push(row);
    session.next = row;
    active++;
    peakActive = Math.max(peakActive, active);
    let unsubscribe;
    if (config.pattern === 'churn' && index % 5 === 1) {
      unsubscribe = session.runner.output.subscribe({
        receive(event) {
          if (event.kind !== 'delta') return;
          row.displayDetached = true;
          unsubscribe(); // Leaving a display does not cancel the underlying call.
        },
      });
    }
    const pending = session.runner
      .run(query)
      .then(
        (value) => {
          row.status = 'succeeded';
          const expected = expectedAnswer(query, config.model.outputBytes);
          row.correctResult = value === expected;
          row.correctPreview = row.preview === expected;
          assert.equal(row.correctResult, true, 'final result crossed requests or lost text');
          assert.equal(row.correctPreview, true, 'preview crossed requests or lost text');
        },
        (error) => {
          row.status = row.rejected ? 'rejected' : error?.code === 'INVOCATION_CANCELLED' ? 'cancelled' : 'failed';
          row.error = { code: typeof error?.code === 'string' ? error.code : 'ERROR', message: error instanceof Error ? error.message : String(error) };
        },
      )
      .catch((error) => {
        row.status = 'failed';
        row.error = { code: 'VALIDATION', message: error.message };
      })
      .finally(() => {
        row.elapsedMs = performance.now() - row.started;
        row.responseFromScheduleMs = performance.now() - scheduled;
        row.previewBytes = Buffer.byteLength(row.preview);
        row.correctPrefix = expectedAnswer(query, config.model.outputBytes).startsWith(row.preview);
        delete row.preview;
        delete row.started;
        for (const [key, value] of session.entries) if (value === row) session.entries.delete(key);
        unsubscribe?.();
        active--;
        running.delete(pending);
      });
    running.add(pending);
    return pending;
  }

  if (config.pattern === 'steady') {
    const count = Math.floor(config.durationSeconds * config.rate);
    for (let index = 0; index < count; index++) {
      const scheduled = began + (index * 1000) / config.rate;
      while (scheduled > performance.now()) await delay(scheduled - performance.now());
      // Fixed offered schedule: no waiting for the preceding request to finish,
      // no hidden queue/retry. Late starts and busy rejections remain visible.
      submit(index % sessions.length, scheduled);
    }
  } else {
    for (let round = 0; round < config.rounds; round++) {
      const scheduled = performance.now();
      await Promise.all(sessions.map((_, index) => submit(index, scheduled)));
    }
  }
  await Promise.all(running);
  const callsEnded = performance.now();
  await Promise.all(sessions.map((session) => session.interactions.settled()));
  const externalEnded = performance.now();
  summary.work = measurement.stop();
  measurement = undefined;
  summary.upstream = await model.snapshot();
  summary.workload = {
    offeredWindowMs: rows.at(-1)?.startedMs ?? 0,
    scheduledWindowMs: rows.at(-1)?.scheduledMs ?? 0,
    callsWindowMs: callsEnded - began,
    externalDrainMs: externalEnded - callsEnded,
    offered: rows.length,
    acquired: rows.filter((row) => row.acquiredMs !== null).length,
    succeeded: rows.filter((row) => row.status === 'succeeded').length,
    rejected: rows.filter((row) => row.status === 'rejected').length,
    cancelled: rows.filter((row) => row.status === 'cancelled').length,
    failed: rows.filter((row) => row.status === 'failed').length,
    detachedDisplays: rows.filter((row) => row.displayDetached).length,
    peakLocalCalls: peakActive,
    peakAcquiredCalls: peakAcquired,
    peakModelCalls: meter.peakActive,
    completedPerSecond: (rows.filter((row) => row.status === 'succeeded').length * 1000) / (callsEnded - began),
  };
  summary.latencyMs = {
    schedulerDelay: distribution(rows.map((row) => row.schedulerDelayMs)),
    acquisition: distribution(rows.map((row) => row.acquiredMs)),
    firstDelta: distribution(rows.map((row) => row.firstDeltaMs)),
    successfulCompletion: distribution(rows.filter((row) => row.status === 'succeeded').map((row) => row.elapsedMs)),
    successfulFromSchedule: distribution(rows.filter((row) => row.status === 'succeeded').map((row) => row.responseFromScheduleMs)),
    failedOrCancelled: distribution(rows.filter((row) => row.status !== 'succeeded').map((row) => row.elapsedMs)),
  };
  summary.models = {
    requests: meter.calls.length,
    requestBytes: meter.calls.reduce((sum, call) => sum + call.requestBytes, 0),
    previewBytes: meter.calls.reduce((sum, call) => sum + call.deltaBytes, 0),
    answer: distribution(meter.calls.filter((call) => call.phase === 'answer').map((call) => call.elapsedMs)),
    memory: distribution(meter.calls.filter((call) => call.phase === 'memory').map((call) => call.elapsedMs)),
    failed: meter.calls.filter((call) => call.status === 'failed').length,
  };
  summary.residual = { runners: sessions.filter((session) => session.runner.isRunning).length, interactions: sessions.filter((session) => session.interactions.active).length, modelCalls: meter.active, upstreamRequests: summary.upstream.active, acquiredCalls: acquiredActive };
  summary.content = sessions.map((session, index) => {
    const state = session.inspect();
    const own = rows.filter((row) => row.session === index);
    assert.equal(state.messages, 1 + own.filter((row) => row.acquiredMs !== null).length + own.filter((row) => row.status === 'succeeded').length);
    assert.equal(state.assistantMessages, own.filter((row) => row.status === 'succeeded').length);
    assert.equal(state.memories, 1, 'the fixture proposes no memory change');
    assert.equal(state.viewMembers, state.messages + 1);
    if (config.profile === 'recording') assert.equal(state.recordingIntegrity, 'intact');
    return state;
  });
  assert.equal(summary.models.requests, summary.workload.acquired + summary.workload.succeeded, 'one answer per accepted input and one memory request per successful answer; never resend');
  assert.equal(summary.models.failed, 0, 'model requests failed, including failures the memory-maintenance policy may have handled');
  assert.equal(summary.upstream.requests, summary.models.requests);
  assert.equal(summary.upstream.completed, summary.models.requests);
  assert.equal(summary.upstream.failed, 0);
  assert.equal(summary.upstream.aborted, 0, 'local cancellation cannot abort independent senders');
  assert.deepEqual(Object.values(summary.residual), [0, 0, 0, 0, 0]);
  assert.deepEqual(observerFailures, []);
  assert.ok(rows.every((row) => row.correctPrefix));
  assert.equal(summary.workload.failed, 0);
  assert.equal(summary.workload.cancelled, rows.filter((row) => row.cancel && row.acquiredMs !== null).length);
  summary.valid = true;
} catch (error) {
  failure = error;
  summary.valid = false;
  summary.failure = { message: error.message, stack: error.stack };
} finally {
  summary.build ??= building?.stop();
  summary.work ??= measurement?.stop();
  const cleanupFailures = [];
  const attempt = async (work) => {
    try {
      await work();
    } catch (error) {
      cleanupFailures.push({ message: error.message, stack: error.stack });
    }
  };
  for (const session of sessions) await attempt(() => session.runner.cancel());
  // On a regression, shutting down the offline upstream unblocks external sends.
  if (failure) await attempt(() => model.close());
  await attempt(() => Promise.all(running));
  for (const session of sessions) {
    for (const unsubscribe of session.subscriptions) await attempt(unsubscribe);
    await attempt(() => session.close());
  }
  summary.persistenceReloads = { expected: config.profile === 'memory' ? 0 : sessions.length, verified: sessions.filter((session) => session.reloadVerified).length };
  for (const [index, state] of (summary.content ?? []).entries()) state.reloadVerified = sessions[index].reloadVerified;
  await attempt(() => {
    assert.equal(summary.persistenceReloads.verified, summary.persistenceReloads.expected);
  });
  await attempt(() => {
    summary.storage = measureStorage(directory);
  });
  sessions.length = 0;
  globalThis.gc?.();
  summary.afterCloseMemory = process.memoryUsage();
  await attempt(() => model.close());
  if (cleanupFailures.length) {
    summary.valid = false;
    summary.cleanupFailures = cleanupFailures;
  }
  writeFileSync(join(directory, 'result.json'), JSON.stringify({ ...summary, rows, modelCalls: meter.calls }, null, 2), { flag: 'wx', mode: 0o600 });
}
if (!summary.valid) process.exitCode = 1;
console.log(JSON.stringify({ name: config.name, valid: summary.valid, workload: summary.workload, latencyMs: summary.latencyMs, failure: summary.failure }));
