import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createConversationInteractions, createConversationResources, createMaterialConversationScene, loadConversationContent } from '@capix/conversation-service/assembly';
import { defaultConversationOutputBudget, ModelCompletionIncomplete } from '@capix/conversation-service';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { createConversationRecording } from '@capix/conversation-service/recording';
import { RecordBook, Recorder } from '@weiliang0121/capix-records';
import { Runner } from '@weiliang0121/capix-runtime';
import { jsonBytes, textBytes, measureFiles, measureDatabase, measureUsage } from './measurement.mjs';
import { renderReport, renderReview } from './report.mjs';

export function validateScenario(scenario) {
  assert.equal(scenario.turns.length, 54);
  assert.deepEqual(scenario.checkpoints, [24, 36, 54]);
  assert.equal(new Set(scenario.turns.map((turn) => turn.id)).size, 54);
  assert.equal(new Set(scenario.turns.map((turn) => turn.input)).size, 54);
  const topics = new Map();
  for (const [index, turn] of scenario.turns.entries()) {
    assert.ok(turn.input.trim());
    for (const item of [...turn.expectations, ...turn.memoryUpdates]) {
      assert.ok(item.sourceTurns.length);
      assert.ok(item.sourceTurns.every((number) => Number.isSafeInteger(number) && number >= 1 && number <= index + 1));
      assert.equal(new Set(item.sourceTurns).size, item.sourceTurns.length);
    }
    for (const update of turn.memoryUpdates) {
      assert.ok(update.content.trim());
      if (topics.has(update.key)) assert.equal(topics.get(update.key), update.topic);
      topics.set(update.key, update.topic);
    }
  }
  assert.equal(new Set(topics.values()).size, topics.size);
}

// Experiment host, using the same default service assembly and public persistence ports as Web.
// Evaluation expectations are written only to review.md; the Runner receives turn.input alone.
export async function runStudy({ scenario, provider, mode, modelName, out, count = 54, onProgress = () => {} }) {
  validateScenario(scenario);
  if (![24, 36, 54].includes(count)) throw new Error('Choose 24, 36 or 54 submissions');
  if (!['offline', 'live'].includes(mode)) throw new Error('Unknown study mode');
  const directory = resolve(out);
  mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
  mkdirSync(directory, { mode: 0o700 }); // Refuse an existing experiment or production database directory.
  const descriptor = openSync(join(directory, 'events.jsonl'), 'wx', 0o600);
  const record = (row) => writeFileSync(descriptor, `${JSON.stringify(row)}\n`);
  const save = (name, value) => writeFileSync(join(directory, name), value, { flag: 'wx', mode: 0o600 });
  const scenarioHash = hash(scenario);
  const database = join(directory, 'conversation.sqlite');
  const rows = [];
  const snapshots = [];
  const reloads = [];
  let host;
  let current;
  let requestCount = 0;
  let providerFailure;
  let failure;
  let totalImageBytes = 0;
  const configuration = JSON.stringify({ study: scenario.id, version: scenario.version, mode, modelName, policy: 'material-conversation-v2', outputBudget: defaultConversationOutputBudget });
  const model = {
    async complete(request, controls = {}) {
      if (requestCount >= count * 2) throw new Error('Study request limit exceeded; no automatic retry is allowed');
      requestCount++;
      const phase = request.responseFormat === 'text' ? 'answer' : 'memory';
      const started = performance.now();
      const payload = JSON.parse(request.messages.find((message) => message.role === 'user').content);
      const measured = {
        number: requestCount,
        phase,
        jsonBytes: jsonBytes(request),
        promptTextBytes: request.messages.reduce((sum, message) => sum + textBytes(message.content), 0),
        httpBodyBytes: null,
        materialMessages: phase === 'answer' ? payload.materials.entries.filter((entry) => entry.source === 'messages').length : payload.messages.length,
        materialMemories: phase === 'answer' ? payload.materials.entries.filter((entry) => entry.source === 'memories').length : payload.memories.length,
        firstDeltaMs: null,
        deltaCount: 0,
        deltaBytes: 0,
      };
      current.requests.push(measured);
      record({ kind: 'model-request', submission: current.number, ...measured, request });
      try {
        // The live provider's transport callback can supply the actual outbound body size.
        const reply = await provider.complete(
          request,
          {
            ...controls,
            ...(request.stream
              ? {
                  emit(delta) {
                    measured.firstDeltaMs ??= performance.now() - started;
                    measured.deltaCount++;
                    measured.deltaBytes += textBytes(delta);
                    controls.emit?.(delta);
                  },
                }
              : {}),
          },
          (bytes) => {
            measured.httpBodyBytes = bytes;
          },
        );
        measured.elapsedMs = performance.now() - started;
        measured.replyBytes = jsonBytes(reply);
        measured.usage = reply.usage;
        measured.finishReason = reply.termination.reason;
        record({ kind: 'model-reply', submission: current.number, ...measured, reply });
        return reply;
      } catch (error) {
        providerFailure = safeFailure(error);
        measured.failure = providerFailure;
        measured.elapsedMs = performance.now() - started;
        record({ kind: 'model-failed', submission: current.number, ...measured });
        throw error;
      }
    },
  };

  function assemble() {
    const store = ConversationStore.open(database);
    let interactions;
    try {
      const content = loadConversationContent(store);
      interactions = createConversationInteractions(model, store.interactions);
      const scene = createMaterialConversationScene();
      const book = new RecordBook();
      const recordSegmentStart = rows.length + 1;
      const recorder = new Recorder(book);
      let recordingIntact = true;
      const recording = createConversationRecording(scene, recorder, {
        invalidate: () => {
          recordingIntact = false;
        },
      });
      const checkpoints = {
        read: (id) => store.checkpoints.read(id),
        save(image, revision) {
          const started = performance.now();
          const receipt = store.checkpoints.save(image, revision);
          current.checkpoints.saveMs += performance.now() - started;
          const bytes = jsonBytes(image);
          current.checkpoints.images++;
          current.checkpoints.imageBytes += bytes;
          current.checkpoints.maxImageBytes = Math.max(current.checkpoints.maxImageBytes, bytes);
          totalImageBytes += bytes;
          return receipt;
        },
        finish(id, revision, delivery) {
          const started = performance.now();
          const receipt = store.checkpoints.finish(id, revision, delivery);
          current.checkpoints.saveMs += performance.now() - started;
          current.checkpoints.deliveries++;
          current.checkpoints.deliveryBytes += jsonBytes(delivery);
          return receipt;
        },
      };
      const runner = new Runner(scene, createConversationResources(content, model, store.view, configuration), interactions, { observations: [recording], checkpoints: { store: checkpoints }, validate: () => store.assertAvailable() }).build();
      const names = new Map();
      const offObservation = runner.observation.subscribe({
        receive(event) {
          if (event.source !== 'invocation') return;
          if (event.fact.kind === 'started') names.set(event.fact.identity.contextId, event.fact.description?.name);
          if (event.fact.kind === 'relation' && names.get(event.fact.relation.childContextId) === 'propose-conversation-memories' && ['accepted', 'handled'].includes(event.fact.phase)) current.memoryReception = event.fact.phase;
        },
      });
      const offOutput = runner.output.subscribe({
        receive(event) {
          if (event.kind === 'delta') {
            current.firstDeltaMs ??= performance.now() - current.started;
            current.previewBytes += textBytes(event.delta);
          }
          if (event.kind === 'completed') current.completedOutputs++;
        },
      });
      return {
        content,
        store,
        runner,
        interactions,
        book,
        recordSegmentStart,
        recordingIntact: () => recordingIntact,
        async close() {
          await interactions.settled();
          offObservation();
          offOutput();
          interactions.close();
          store.close();
        },
      };
    } catch (error) {
      interactions?.close();
      store.close();
      throw error;
    }
  }

  try {
    save('scenario.json', JSON.stringify(scenario, null, 2));
    record({ kind: 'study', scenario: scenario.id, version: scenario.version, scenarioHash, nodeVersion: process.version, mode, modelName, planned: count, maxRequests: count * 2, startedAt: new Date().toISOString(), note: 'One turn is one user submission; fixture expectations are never model input. Default View policy unchanged. Timings include experiment instrumentation.' });
    host = assemble();
    for (const [index, turn] of scenario.turns.slice(0, count).entries()) {
      const before = host.content.transcript.length;
      current = { number: index + 1, id: turn.id, topic: turn.topic, input: turn.input, started: performance.now(), requests: [], firstDeltaMs: null, previewBytes: 0, completedOutputs: 0, memoryReception: 'not-observed', checkpoints: { images: 0, imageBytes: 0, maxImageBytes: 0, deliveries: 0, deliveryBytes: 0, saveMs: 0 } };
      try {
        current.result = await host.runner.run(turn.input);
        assert.equal(host.content.transcript.length, before + 2);
        assert.equal(host.content.transcript.get(before).content, turn.input);
        assert.equal(host.content.transcript.get(before + 1).content, current.result);
        assert.equal(current.completedOutputs, 1);
        assert.equal(host.runner.isRunning, false);
        assert.equal(host.recordingIntact(), true);
      } catch (error) {
        current.failure = safeFailure(error);
        failure = current.failure;
      }
      current.elapsedMs = performance.now() - current.started;
      current.checkpoints.totalImageBytes = totalImageBytes;
      current.content = { messages: host.content.transcript.length, memories: host.content.memories.values().length, memorySequence: host.content.memories.sequence, members: host.content.view.members().length };
      const measurementStarted = performance.now();
      const records = host.book.exportState();
      current.records = { fromSubmission: host.recordSegmentStart, entries: records.entries.length, jsonBytes: jsonBytes(records) };
      current.files = measureFiles(database);
      current.measurementMs = performance.now() - measurementStarted;
      delete current.started;
      rows.push(current);
      record({ kind: 'submission', ...current, memories: host.content.memories.snapshot() });
      onProgress(current);
      if (failure || providerFailure) break;
      if (scenario.checkpoints.includes(current.number)) {
        const saved = host.store.load();
        const digest = hash(saved);
        save(`content-${current.number}.json`, JSON.stringify(saved, null, 2));
        await host.close();
        host = undefined;
        const snapshot = { after: current.number, database: measureDatabase(database) };
        snapshots.push(snapshot);
        record({ kind: 'database', ...snapshot });
        if (current.number < count) {
          const previousRequests = requestCount;
          host = assemble();
          const equal = hash(host.store.load()) === digest;
          assert.ok(equal, 'Reload changed saved content');
          assert.equal(requestCount, previousRequests, 'Reload unexpectedly sent a model request');
          reloads.push({ after: current.number, equal, requestCount });
          record({ kind: 'reload', ...reloads.at(-1) });
        }
      }
    }
  } catch (error) {
    failure = safeFailure(error);
    record({ kind: 'study-failed', failure });
  } finally {
    try {
      if (host) {
        await host.close();
        host = undefined;
        const snapshot = { after: rows.length, database: measureDatabase(database) };
        snapshots.push(snapshot);
        record({ kind: 'database', ...snapshot });
      }
    } catch (error) {
      failure ??= safeFailure(error);
    }
    closeSync(descriptor);
  }
  const phases = Object.fromEntries(
    ['answer', 'memory'].map((phase) => {
      const requests = rows.flatMap((row) => row.requests).filter((request) => request.phase === phase);
      return [phase, { requests: requests.length, jsonBytes: requests.reduce((sum, request) => sum + request.jsonBytes, 0), measuredHttpRequests: requests.filter((request) => request.httpBodyBytes !== null).length, httpBodyBytes: requests.reduce((sum, request) => sum + (request.httpBodyBytes ?? 0), 0), ...measureUsage(requests) }];
    }),
  );
  const maintenance = Object.fromEntries(['accepted', 'handled', 'not-observed'].map((status) => [status, rows.filter((row) => row.memoryReception === status).length]));
  const summary = { scenario: scenario.id, version: scenario.version, scenarioHash, nodeVersion: process.version, mode, modelName, outputBudget: defaultConversationOutputBudget, planned: count, completed: rows.filter((row) => !row.failure).length, modelCalls: requestCount, complete: rows.length === count && !failure && !providerFailure, failure, providerFailure, checkpoints: scenario.checkpoints.filter((number) => number <= count), totalImageBytes, phases, maintenance, snapshots, reloads, semanticEvaluation: mode === 'offline' ? 'not-applicable' : 'manual-review-required' };
  save('summary.json', JSON.stringify(summary, null, 2));
  save('report.md', renderReport(summary, rows));
  save('review.md', renderReview(scenario.turns, rows, mode));
  return summary;
}

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function safeFailure(error) {
  // Never serialize arbitrary causes, headers or Error properties from external adapters.
  if (error instanceof ModelCompletionIncomplete) return { name: error.name, code: error.code, finishReason: error.finishReason, maxTokens: error.maxTokens };
  return { name: error instanceof Error ? error.name : typeof error, ...(typeof error?.code === 'string' ? { code: error.code } : {}) };
}
