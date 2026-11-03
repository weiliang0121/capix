import type { ModelProvider } from '@capix/model-provider';
import { RecordBook, Recorder } from '@capix/records';
import { Runner } from '@capix/server-runtime';
import { createConversationInteractions, createConversationResources, createMaterialConversationScene, loadConversationContent } from '../assembly/index.js';
import { ConversationStore } from '../persistence/index.js';
import { createConversationRecording } from '../recording/index.js';
import { inspectConversation, inspectConversationCall } from '../recording/inspection.js';
import { ConversationEvents } from '../http/events.js';
import { createConversationServer } from '../http/server.js';

export interface ConversationWebHostOptions {
  readonly database: string;
  readonly model: ModelProvider;
  readonly mode: 'demo' | 'live';
  readonly modelName: string;
  readonly assetsDirectory?: string;
}

/** The executable host owns the store and independent senders; HTTP only consumes their ports. */
export function createConversationWebHost(options: ConversationWebHostOptions) {
  const store = ConversationStore.open(options.database);
  let interactions: ReturnType<typeof createConversationInteractions> | undefined;
  let http: ReturnType<typeof createConversationServer> | undefined;
  try {
    const content = loadConversationContent(store);
    interactions = createConversationInteractions(options.model);
    const scene = createMaterialConversationScene();
    const events = new ConversationEvents(content.transcript);
    const recorder = new Recorder(new RecordBook());
    let integrity: 'intact' | 'incomplete' = 'intact';
    const recording = createConversationRecording(scene, recorder, {
      invalidate: () => {
        integrity = 'incomplete';
      },
    });
    const runner = new Runner(scene, createConversationResources(content, options.model, store.view), interactions, {
      observations: [recording, events.observation],
      validate: () => {
        store.assertAvailable();
      },
    }).build();
    http = createConversationServer({
      runner,
      transcript: content.transcript,
      events,
      mode: options.mode,
      model: options.modelName,
      assertAvailable: () => store.assertAvailable(),
      inspect: () => inspectConversation(content, recorder, recording.root, integrity),
      call: (id) => inspectConversationCall(recorder, recording.root, id, integrity),
      assetsDirectory: options.assetsDirectory,
    });
  } catch (error) {
    const failures = [error];
    try {
      http?.close();
    } catch (cause) {
      failures.push(cause);
    }
    try {
      interactions?.close();
    } catch (cause) {
      failures.push(cause);
    }
    try {
      store.close();
    } catch (cause) {
      failures.push(cause);
    }
    throw failures.length === 1 ? error : new AggregateError(failures, 'Conversation host initialization failed');
  }
  const active = http;
  const senders = interactions;
  let closing: Promise<void> | undefined;
  return { server: active.server, close: () => (closing ??= close()) };

  async function close(): Promise<void> {
    const failures: unknown[] = [];
    active.stop();
    // Stop admission first; existing feedback consumers can still see the local terminal result.
    const stopped = new Promise<void>((resolve) =>
      active.server.close((error) => {
        if (error && Reflect.get(error, 'code') !== 'ERR_SERVER_NOT_RUNNING') failures.push(error);
        resolve();
      }),
    );
    try {
      await active.settled();
    } catch (error) {
      failures.push(error);
    }
    try {
      await senders.settled();
    } catch (error) {
      failures.push(error);
    }
    try {
      active.close();
    } catch (error) {
      failures.push(error);
    }
    active.server.closeAllConnections();
    await stopped;
    try {
      senders.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      store.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, 'Conversation host shutdown failed');
  }
}
