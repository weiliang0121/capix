import { closeSync, mkdirSync, openSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createConversationInteractions, createConversationResources, createMaterialConversationScene, loadConversationContent } from '@capix/conversation-service/assembly';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { ConversationRecording } from '@capix/conversation-service/recording';
import { Memories, MemoryViewSource } from '@capix/memory';
import { Runner } from '@capix/server-runtime';
import { Transcript, TranscriptViewSource } from '@capix/transcript';
import { View } from '@capix/view';

const profiles = new Set(['memory', 'sqlite', 'checkpoint', 'recording']);
const configuration = 'capacity-material-conversation-v1';

function emptyContent() {
  const transcript = new Transcript();
  const memories = new Memories(transcript);
  const view = new View({ revision: 0, sources: { messages: { id: transcript.id, scope: 'whole' }, memories: { id: memories.id, scope: 'whole' } }, members: [] });
  return { transcript, memories, view };
}

/** Identical service policy across profiles; persistence and installed mechanisms vary. */
export function createCapacitySession({ index, model, directory, profile, historyBytes = 2048 }) {
  if (!profiles.has(profile)) throw new TypeError('Unknown capacity profile');
  if (!Number.isSafeInteger(index) || index < 0) throw new RangeError('Session index must be nonnegative');
  if (!Number.isSafeInteger(historyBytes) || historyBytes < 0 || historyBytes > 1024 * 1024) throw new RangeError('History byte count must be within 0..1 MiB');
  if (!model || typeof model.complete !== 'function') throw new TypeError('A shared model provider is required');
  let store;
  let interactions;
  let recording;
  let databasePath;
  try {
    if (profile !== 'memory') {
      if (typeof directory !== 'string' || !directory) throw new TypeError('Persistent profiles require an experiment directory');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const file = join(directory, `session-${index}.sqlite`);
      databasePath = file;
      // Never reuse an existing run's database or accidentally benchmark a user's data.
      closeSync(openSync(file, 'wx', 0o600));
      store = ConversationStore.open(file);
    }
    const content = store ? loadConversationContent(store) : emptyContent();
    const marker = `session-${index}:private-history\n`;
    const history = marker + 'x'.repeat(Math.max(0, historyBytes - Buffer.byteLength(marker)));
    content.transcript.append({ role: 'user', content: history });
    const [memory] = content.memories.apply([{ action: 'create', memoryId: null, change: 'Seed one private capacity fixture fact', sourceIndexes: [0], result: { topic: 'capacity fixture', content: `session-${index}:private-memory`, sourceIndexes: [0] } }]);
    content.view.includeSync(
      { messages: new TranscriptViewSource(content.transcript), memories: new MemoryViewSource(content.memories) },
      [
        { source: 'messages', key: 0 },
        { source: 'memories', key: memory.id },
      ],
      store?.view,
    );

    interactions = createConversationInteractions(model, store?.interactions);
    const scene = createMaterialConversationScene();
    recording = new ConversationRecording(scene);
    // Web installs this control while idle too. Only the recording profile starts
    // a capture; recording is not a default log attached to every conversation.
    const runner = new Runner(scene, createConversationResources(content, model, store?.view, configuration), interactions, {
      observations: [recording],
      ...(['checkpoint', 'recording'].includes(profile) ? { checkpoints: { store: store.checkpoints } } : {}),
      validate: () => store?.assertAvailable(),
    }).build();
    if (profile === 'recording') recording.start();
    let closing;
    let reloadVerified = false;
    return {
      runner,
      content,
      interactions,
      recording,
      store,
      get reloadVerified() {
        return reloadVerified;
      },
      /** Capture only outside the timed interval; counts do not drive execution. */
      inspect() {
        const messages = content.transcript.snapshot();
        const capture = profile === 'recording' ? recording.inspect(content).recording : undefined;
        return {
          messages: messages.length,
          userMessages: messages.filter((message) => message.role === 'user').length,
          assistantMessages: messages.filter((message) => message.role === 'assistant').length,
          memories: content.memories.values().length,
          viewMembers: content.view.members().length,
          historyBytes: Buffer.byteLength(history),
          running: runner.isRunning,
          sending: interactions.active,
          recordingStatus: recording.state().status,
          recordingIntegrity: capture?.integrity,
          recordedCalls: capture?.calls.length ?? 0,
          reloadVerified,
        };
      },
      close() {
        closing ??= closeSession(runner, interactions, recording, store, content, databasePath, () => {
          reloadVerified = true;
        });
        return closing;
      },
    };
  } catch (error) {
    const failures = [error];
    for (const close of [() => interactions?.close(), () => store?.close()]) {
      try {
        close();
      } catch (cause) {
        failures.push(cause);
      }
    }
    throw failures.length === 1 ? error : new AggregateError(failures, 'Capacity session assembly failed');
  }
}

async function closeSession(runner, interactions, recording, store, content, databasePath, didReload) {
  if (runner.isRunning) {
    // The ordinary harness already joins its owned calls. This fallback still
    // waits for actual local exit before the store or sender owner can be closed.
    const stopped = Promise.withResolvers();
    const detach = runner.observation.subscribe({
      receive(event) {
        if (event.source === 'entry' && event.fact.kind === 'settled' && !runner.isRunning) stopped.resolve();
      },
    });
    try {
      runner.cancel();
      await stopped.promise;
    } finally {
      detach();
    }
  }
  await interactions.settled();
  const expected = store ? { transcript: content.transcript.exportState(), memories: content.memories.exportState(), view: content.view.exportState() } : undefined;
  const failures = [];
  for (const close of [() => recording.stop(), () => interactions.close(), () => store?.close()]) {
    try {
      close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Capacity session shutdown failed');
  if (store) {
    // Outside the workload interval: load through the public host store, including
    // canonical content and fixed-receipt checks. This never resumes old calls.
    const reopened = ConversationStore.open(databasePath);
    try {
      if (!isDeepStrictEqual(reopened.load(), expected)) throw new Error('Persisted capacity content differs after reopening');
      didReload();
    } finally {
      reopened.close();
    }
  }
}

/** Inspect closed experiment databases only; opening a second writer is never used. */
export function measureStorage(directory) {
  const tables = { messages: 0, memories: 0, append_receipts: 0, apply_receipts: 0, checkpoint_images: 0, checkpoint_heads: 0, completion_interactions: 0, model_exchanges: 0, model_exchange_entries: 0 };
  const result = { databases: 0, databaseBytes: 0, walBytes: 0, shmBytes: 0, totalBytes: 0, tables, checkpointRetainedBodies: 0, checkpointDiscardedBodies: 0, checkpointStoredBytes: 0, checkpointJsonBytes: 0, checkpointValueStoredBytes: 0, checkpointValueJsonBytes: 0, checkpointMetadataBytes: 0, deliveryStoredBytes: 0, deliveryJsonBytes: 0, interactionStoredBytes: 0, exchangeStoredBytes: 0, exchangeMetadataBytes: 0, archiveJsonBytes: 0 };
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^session-\d+\.sqlite$/.test(entry.name)) continue;
    const path = join(directory, entry.name);
    result.databases++;
    result.databaseBytes += statSync(path).size;
    let walBytes = 0;
    for (const [suffix, key] of [
      ['-wal', 'walBytes'],
      ['-shm', 'shmBytes'],
    ]) {
      try {
        const bytes = statSync(path + suffix).size;
        result[key] += bytes;
        if (suffix === '-wal') walBytes = bytes;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (walBytes !== 0) throw new Error('Close the capacity host before measuring SQL contents: a nonempty WAL remains');
    // Read-only WAL connections can still create sidecars. Immutable mode avoids
    // that mutation, but is valid only while this host stays closed and WAL is empty.
    const uri = pathToFileURL(path);
    uri.searchParams.set('immutable', '1');
    const database = new DatabaseSync(uri.href, { readOnly: true, timeout: 0 });
    try {
      if (database.prepare('PRAGMA application_id').get().application_id !== 0x43415043 || ![5, 6, 7].includes(database.prepare('PRAGMA user_version').get().user_version)) throw new Error('Expected an experiment conversation database in storage format 5/6/7');
      for (const table of Object.keys(tables)) tables[table] += database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count;
      const images = database.prepare("SELECT COUNT(body) AS retained, COUNT(*) - COUNT(body) AS discarded, coalesce(sum(length(CAST(body AS BLOB))), 0) AS stored, coalesce(sum(CASE WHEN body IS NULL THEN 0 ELSE coalesce(json_extract(body, '$.jsonBytes'), length(CAST(body AS BLOB))) END), 0) AS original FROM checkpoint_images").get();
      result.checkpointRetainedBodies += images.retained;
      result.checkpointDiscardedBodies += images.discarded;
      result.checkpointStoredBytes += images.stored;
      result.checkpointJsonBytes += images.original;
      const deliveries = database.prepare("SELECT coalesce(sum(length(CAST(delivery AS BLOB))), 0) AS stored, coalesce(sum(json_extract(delivery, '$.jsonBytes')), 0) AS original FROM checkpoint_heads WHERE delivery IS NOT NULL").get();
      if (database.prepare('PRAGMA user_version').get().user_version >= 7) {
        const values = database.prepare("SELECT coalesce(sum(length(CAST(body AS BLOB))), 0) AS stored, coalesce(sum(json_extract(body, '$.jsonBytes')), 0) AS original, coalesce(sum(length(CAST(metadata AS BLOB))), 0) AS metadata FROM checkpoint_values").get();
        result.checkpointValueStoredBytes += values.stored;
        result.checkpointValueJsonBytes += values.original;
        result.checkpointMetadataBytes += values.metadata + database.prepare('SELECT coalesce(sum(length(CAST(body AS BLOB))), 0) AS bytes FROM checkpoint_relations').get().bytes;
      }
      result.deliveryStoredBytes += deliveries.stored;
      result.deliveryJsonBytes += deliveries.original;
      result.interactionStoredBytes += database.prepare('SELECT coalesce(sum(length(CAST(body AS BLOB))), 0) AS bytes FROM completion_interactions').get().bytes;
      result.exchangeStoredBytes += database.prepare('SELECT coalesce(sum(length(CAST(body AS BLOB))), 0) AS bytes FROM model_exchange_entries').get().bytes;
      result.exchangeMetadataBytes += database.prepare('SELECT coalesce(sum(length(CAST(metadata AS BLOB))), 0) AS bytes FROM model_exchanges').get().bytes;
    } finally {
      database.close();
    }
  }
  result.totalBytes = result.databaseBytes + result.walBytes + result.shmBytes;
  // The same retained JSON categories used by host admission, computed independently
  // of its ledger. Neither file lengths nor cumulative write traffic are this total.
  result.archiveJsonBytes = result.checkpointValueJsonBytes + result.checkpointMetadataBytes + result.checkpointJsonBytes + result.deliveryJsonBytes + result.interactionStoredBytes + result.exchangeStoredBytes + result.exchangeMetadataBytes;
  return result;
}
