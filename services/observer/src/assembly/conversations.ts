import { randomUUID } from 'node:crypto';
import { RuntimeError } from '@capix/server-runtime';
import { Transcript, Memories } from '@capix/server-runtime/content';
import type { ConversationDescriptor, ConversationListResponse, Message } from '@capix/protocol';
import type { ModelInitialization } from '../conversation/model/types.js';
import { conversationTitle } from '../conversation/title.js';
import { ModelSource } from '../conversation/model/source.js';
import type { WorkspaceFiles } from '../files/index.js';
import type { ConversationDecisionDefinition } from '../conversation/decision/types.js';
import type { SqliteObserverStore } from '../persistence/store.js';
import { initializeObserver } from './environment.js';
import { restoreConversationContent, type ConversationContent } from './content.js';

/** Service-owned association of conversations, content and optional running/observed environments. */
export class ObserverConversations {
  readonly model: ModelSource;
  readonly files?: WorkspaceFiles;
  readonly persistence?: SqliteObserverStore;
  readonly #descriptors = new Map<string, ConversationDescriptor>();
  readonly #content = new Map<string, ConversationContent>();
  readonly #environments = new Map<string, ReturnType<typeof initializeObserver>>();
  readonly #defaultId: string;
  #closed = false;

  constructor(
    private readonly provider: ModelInitialization,
    messages: readonly Message[] = [],
    private readonly options: { files?: WorkspaceFiles; decision?: ConversationDecisionDefinition; maxDecisionSteps?: number; persistence?: SqliteObserverStore } = {},
  ) {
    this.model = new ModelSource(provider);
    this.files = options.files;
    this.persistence = options.persistence;
    const existing = this.persistence?.list();
    if (existing?.conversations.length) {
      if (messages.length) throw new Error('Cannot append startup messages to restored conversations');
      this.#defaultId = existing.defaultConversationId;
      for (const descriptor of existing.conversations) this.#descriptors.set(descriptor.id, descriptor);
    } else {
      // Validate a previously empty database before treating it as a new world.
      this.persistence?.load();
      this.#defaultId = this.createContent(messages).id;
    }
  }

  list(): ConversationListResponse {
    this.requireOpen();
    if (this.persistence && !this.persistence.failure) {
      const current = this.persistence.list();
      for (const descriptor of current.conversations) this.#descriptors.set(descriptor.id, descriptor);
      return current;
    }
    for (const content of this.#content.values()) content.consumer.flush();
    return { conversations: [...this.#descriptors.values()].sort((left, right) => right.updatedAt - left.updatedAt), defaultConversationId: this.#defaultId };
  }

  get(id: string): ConversationDescriptor {
    const descriptor = this.list().conversations.find((value) => value.id === id);
    if (!descriptor) throw new RuntimeError('CONVERSATION_NOT_FOUND', '未找到对话。');
    return descriptor;
  }

  create(): ConversationDescriptor {
    this.requireOpen();
    return this.createContent([]);
  }

  content(id: string): ConversationContent {
    this.get(id);
    const known = this.#content.get(id);
    if (known) return known;
    const saved = this.persistence!.load(id);
    const content = restoreConversationContent(saved, [], this.persistence);
    this.#content.set(id, content);
    return content;
  }

  forTranscript(id: string): ConversationContent {
    const descriptor = this.list().conversations.find((value) => value.transcriptId === id);
    if (!descriptor) throw new RuntimeError('TRANSCRIPT_NOT_FOUND', '未找到消息集合。');
    return this.content(descriptor.id);
  }

  /** Explicit observation or execution initializes only this conversation's runtime binding. */
  open(id: string): ReturnType<typeof initializeObserver> {
    const content = this.content(id);
    const known = this.#environments.get(id);
    if (known) return known;
    const environment = initializeObserver(this.provider, [], { ...this.options, conversationId: id, content, model: this.model, shared: true });
    this.#environments.set(id, environment);
    return environment;
  }

  peek(id: string): ReturnType<typeof initializeObserver> | undefined {
    this.get(id);
    return this.#environments.get(id);
  }

  get active(): boolean {
    return [...this.#environments.values()].some((environment) => environment.runtime.running || environment.interactions.active);
  }

  close(): void {
    if (this.#closed) return;
    if (this.active) throw new Error('Cannot close conversations with active work');
    for (const environment of this.#environments.values()) environment.close();
    for (const content of this.#content.values()) {
      content.transcripts.close();
      content.consumer.close();
    }
    this.persistence?.close();
    this.#closed = true;
  }

  private createContent(messages: readonly Message[]): ConversationDescriptor {
    const transcript = new Transcript(messages);
    const memories = new Memories(transcript);
    const now = Date.now();
    const descriptor = this.persistence ? this.persistence.createConversation({ transcript: transcript.exportState(), memories: memories.exportState() }) : Object.freeze({ id: randomUUID(), title: conversationTitle(transcript.snapshot()), transcriptId: transcript.id, createdAt: now, updatedAt: now });
    const saved = { version: 1 as const, transcript: transcript.exportState(), memories: memories.exportState(), recording: { book: { entries: [] }, archives: [] } };
    const content = restoreConversationContent(saved, [], this.persistence);
    this.#descriptors.set(descriptor.id, descriptor);
    this.#content.set(descriptor.id, content);
    if (!this.persistence)
      content.consumer.subscribe((change) => {
        if (change.type !== 'transcript' && change.type !== 'memory') return;
        this.#descriptors.set(descriptor.id, Object.freeze({ ...descriptor, title: conversationTitle(content.transcript.snapshot()), updatedAt: Date.now() }));
      });
    return descriptor;
  }

  private requireOpen(): void {
    if (this.#closed) throw new RuntimeError('SERVICE_CLOSED', '服务已关闭。');
  }
}
