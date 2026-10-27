import { randomUUID } from 'node:crypto';
import { RuntimeError } from '@capix/contracts';
import { type ObservationInstallation } from '@capix/server-runtime';
import { type InvocationControls, type CheckpointInstallation } from '@capix/invocation';
import { Transcript } from '@capix/transcript';
import { Memories } from '@capix/memory';
import type { ConversationDescriptor, ConversationListResponse, Message } from '@capix/protocol';
import type { ModelInitialization } from '../conversation/model/types.js';
import { conversationTitle } from '../conversation/title.js';
import { ModelSource } from '../conversation/model/source.js';
import type { WorkspaceFiles } from '../files/index.js';
import type { ContextMaintenanceConfiguration } from '../conversation/group/context/maintain.js';
import type { ConversationDecisionFactory } from '../conversation/decision/types.js';
import type { SqliteObserverStore } from '../persistence/store.js';
import { initializeObserver } from './initialize.js';
import type { ObserverEnvironment } from './environment.js';
import { ConversationContent } from '@capix/observer-content';

/** Service-owned association of conversations, content and optional running/observed environments. */
export class ObserverConversations {
  readonly model: ModelSource;
  readonly files?: WorkspaceFiles;
  readonly persistence?: SqliteObserverStore;
  readonly #descriptors = new Map<string, ConversationDescriptor>();
  readonly #content = new Map<string, ConversationContent>();
  readonly #environments = new Map<string, ObserverEnvironment>();
  readonly #defaultId: string;
  #closed = false;

  constructor(
    private readonly provider: ModelInitialization,
    messages: readonly Message[] = [],
    private readonly options: { observations?: readonly ObservationInstallation[]; files?: WorkspaceFiles; decision?: ConversationDecisionFactory; maxDecisionSteps?: number; maintenance?: ContextMaintenanceConfiguration; persistence?: SqliteObserverStore; checkpointObservation?: CheckpointInstallation['observation'] } = {},
  ) {
    // Lazy environments share one host configuration; caller-owned containers remain mutable.
    this.options = Object.freeze({ ...options, observations: options.observations ? Object.freeze([...options.observations]) : undefined });
    this.model = new ModelSource(provider);
    this.files = this.options.files;
    this.persistence = this.options.persistence;
    const existing = this.persistence?.list();
    if (existing?.conversations.length) {
      if (messages.length) throw new Error('Cannot append startup messages to restored conversations');
      this.#defaultId = existing.defaultConversationId;
      for (const descriptor of existing.conversations) this.#descriptors.set(descriptor.id, descriptor);
    } else {
      // Validate a previously empty database before treating it as a new world.
      this.persistence?.loadContent();
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
    this.requireOpen();
    const descriptor = this.persistence && !this.persistence.failure ? this.persistence.conversation(id) : this.#descriptors.get(id);
    if (descriptor) this.#descriptors.set(id, descriptor);
    if (!this.persistence) this.#content.get(id)?.consumer.flush();
    if (!descriptor) throw new RuntimeError('CONVERSATION_NOT_FOUND', '未找到对话。');
    return this.#descriptors.get(id)!;
  }

  create(): ConversationDescriptor {
    this.requireOpen();
    return this.createContent([]);
  }

  content(id: string): ConversationContent {
    this.get(id);
    const known = this.#content.get(id);
    if (known) {
      if (known.closed) throw new RuntimeError('SERVICE_CLOSED', '对话内容同步已关闭。');
      return known;
    }
    const saved = this.persistence!.loadContent(id);
    const content = new ConversationContent({ saved, persistence: this.persistence });
    this.#content.set(id, content);
    return content;
  }

  forTranscript(id: string): ConversationContent {
    this.requireOpen();
    const descriptor = this.persistence && !this.persistence.failure ? this.persistence.conversationForTranscript(id) : [...this.#descriptors.values()].find((value) => value.transcriptId === id);
    if (!descriptor) throw new RuntimeError('TRANSCRIPT_NOT_FOUND', '未找到消息集合。');
    return this.content(descriptor.id);
  }

  /** Explicit observation or execution initializes only this conversation's runtime binding. */
  open(id: string): ObserverEnvironment {
    const content = this.content(id);
    const known = this.#environments.get(id);
    if (known) {
      if (known.closed) throw new RuntimeError('SERVICE_CLOSED', '该对话的运行环境已关闭。');
      return known;
    }
    const environment = initializeObserver(this.provider, [], { ...this.options, conversationId: id, content, model: this.model, shared: true });
    this.#environments.set(id, environment);
    return environment;
  }

  /** Explicit host recovery of one registered root; never automatic replay or a restored Submission. */
  recover(conversationId: string, rootContextId: string, controls: InvocationControls = {}) {
    return this.open(conversationId).recover(rootContextId, controls);
  }

  peek(id: string): ObserverEnvironment | undefined {
    this.get(id);
    const environment = this.#environments.get(id);
    if (environment?.closed) throw new RuntimeError('SERVICE_CLOSED', '该对话的运行环境已关闭。');
    return environment;
  }

  get active(): boolean {
    return [...this.#environments.values()].some((environment) => environment.active);
  }

  close(): void {
    if (this.#closed) return;
    if (this.active) throw new Error('Cannot close conversations with active work');
    this.#closed = true;
    const failures: unknown[] = [];
    for (const environment of this.#environments.values()) {
      try {
        environment.close();
      } catch (error) {
        failures.push(error);
      }
    }
    for (const content of this.#content.values()) {
      try {
        content.close();
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      this.persistence?.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'Observer conversations cleanup failed');
  }

  private createContent(messages: readonly Message[]): ConversationDescriptor {
    const transcript = new Transcript(messages);
    const memories = new Memories(transcript);
    const now = Date.now();
    const descriptor = this.persistence ? this.persistence.createConversation({ transcript: transcript.exportState(), memories: memories.exportState() }) : Object.freeze({ id: randomUUID(), title: conversationTitle(transcript.snapshot()), transcriptId: transcript.id, createdAt: now, updatedAt: now });
    const saved = { version: 1 as const, transcript: transcript.exportState(), memories: memories.exportState() };
    const content = new ConversationContent({ saved, persistence: this.persistence });
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
