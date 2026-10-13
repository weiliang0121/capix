import type { ConversationDescriptor, ConversationListResponse, ConversationSubmissionDiscovery, ConfigurationResponse, ConversationRequest, Message, ExecutionRecordSnapshot, InteractionObservation } from '@capix/protocol';
import type { ConversationTransport, ObservationTransport, TranscriptTransport } from './transport.js';
import { TranscriptReceiver, type TranscriptState } from './transcript.js';
import { ObservationReceiver, type ObservationState } from './observation/receiver.js';
import { ClientSubmission, type ClientSubmissionState } from './submission.js';
import { InitializationAttempt, type ClientInitializationState } from './initialization.js';
import { ConversationQueue, type ClientQueueState, type ConversationQueueOptions } from './queue.js';
import { coordinateConversation, type ContentAvailability } from './conversation.js';
import { InteractionObserver } from './observation/interactions.js';
import { acceptTrackingLocator, type ClientTrackingLocator, type ClientTrackingStore } from './tracking.js';

export interface ClientState {
  readonly conversation?: ConversationDescriptor;
  readonly conversations: readonly ConversationDescriptor[];
  readonly switching: boolean;
  readonly canSwitchConversation: boolean;
  readonly conversationError?: unknown;
  /** Optional host storage failure; never changes the service's business result. */
  readonly trackingError?: unknown;
  readonly initialization: ClientInitializationState;
  readonly config?: ConfigurationResponse;
  readonly messages: readonly Readonly<Message>[];
  readonly transcriptId?: string;
  readonly transcripts: ReadonlyMap<string, TranscriptState>;
  readonly submission?: ClientSubmissionState;
  /** Recent locally followed submissions; separate from authoritative transcript history. */
  readonly submissions: ReadonlyMap<string, ClientSubmissionState>;
  readonly queue: ClientQueueState;
  readonly busy: boolean;
  readonly pending: string;
  readonly contextId: string;
  readonly answered: boolean;
  readonly inputAvailability: ContentAvailability;
  readonly answerAvailability: ContentAvailability;
  readonly error?: unknown;
  readonly observation: ObservationState;
}

export interface ClientRuntimeOptions {
  readonly conversation: ConversationTransport;
  readonly transcripts: TranscriptTransport;
  readonly observation?: ObservationTransport;
  readonly queue?: ConversationQueueOptions;
  readonly tracking?: ClientTrackingStore;
}

type ClientSources = Pick<ClientState, 'conversation' | 'conversations' | 'switching' | 'conversationError' | 'trackingError' | 'initialization' | 'config' | 'transcriptId' | 'transcripts' | 'submission' | 'submissions' | 'queue' | 'error' | 'observation'>;

/** Business delivery is independent of the optional observation capability. */
export class ClientRuntime {
  private sources: ClientSources;
  private state: ClientState;
  private dirty = false;
  private scheduled = false;
  private publishing = false;
  private readonly acceptances = new Set<ClientSubmission>();
  private readonly listeners = new Set<() => void>();
  private initialization?: InitializationAttempt;
  private initializationNumber = 0;
  private readonly queue: ConversationQueue;
  private opening = 0;
  private openingTranscript?: string;
  private catalogRequest = 0;
  private catalogRefreshSubmission?: string;
  private readonly tracking?: ClientTrackingStore;
  private trackingLoaded = false;
  private trackingLocator?: ClientTrackingLocator;

  private readonly conversation: ConversationTransport;
  private readonly observation: ObservationReceiver;
  private readonly transcripts: TranscriptReceiver;
  private readonly interactions: InteractionObserver;

  constructor(options: ClientRuntimeOptions) {
    this.conversation = options.conversation;
    this.tracking = options.tracking;
    this.interactions = new InteractionObserver(options.observation);
    this.observation = new ObservationReceiver(options.observation, (observation) => {
      this.update({ observation });
    });
    this.transcripts = new TranscriptReceiver(options.transcripts, (transcripts) => {
      this.update({ transcripts });
    });
    this.queue = new ConversationQueue(
      this.conversation,
      () => ({ ready: !this.sources.switching && this.sources.initialization.status === 'succeeded' && !!this.sources.config?.configured, conversationId: this.sources.conversation?.id, transcriptId: this.sources.transcriptId }),
      (submission) => this.updateSubmission(submission),
      options.queue,
    );
    this.sources = { conversations: Object.freeze([]), switching: false, initialization: { status: 'idle' }, transcripts: new Map(), submissions: new Map(), observation: this.observation.snapshot, queue: this.queue.snapshot };
    this.state = Object.freeze({ ...this.sources, canSwitchConversation: this.canSwitchConversation, ...coordinateConversation(this.sources) });
  }

  readonly getSnapshot = (): ClientState => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private update(change: Partial<ClientSources>): void {
    this.sources = { ...this.sources, ...change };
    this.dirty = true;
    if ('initialization' in change || 'transcriptId' in change || 'switching' in change) this.queue.checkEnvironment();
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.publish();
    });
  }

  /** Publish a coherent read model. Reentrant commands affect the next publication only. */
  private publish(): void {
    if (!this.dirty || this.publishing) return;
    this.publishing = true;
    this.dirty = false;
    this.state = Object.freeze({ ...this.sources, canSwitchConversation: this.canSwitchConversation, ...coordinateConversation(this.sources) });
    const acceptances = [...this.acceptances].map((submission) => ({ submission, snapshot: submission.snapshot }));
    this.acceptances.clear();
    const listeners = [...this.listeners];
    try {
      for (const listener of listeners) {
        if (!this.listeners.has(listener)) continue;
        try {
          listener();
        } catch {
          // A consumer cannot reject source facts or interrupt other subscribers.
          this.listeners.delete(listener);
        }
      }
      for (const { submission, snapshot } of acceptances) {
        submission.publishAcceptance(snapshot);
        if (submission.snapshot !== snapshot) this.updateSubmission(submission);
      }
    } finally {
      this.publishing = false;
    }
  }

  initialize(): Promise<void> {
    if (this.initialization?.running) return this.initialization.promise;
    // Once configured, reconnecting content does not reclassify service admission.
    if (this.sources.initialization.status === 'succeeded' && this.sources.config && this.sources.transcriptId) return this.transcripts.watch(this.sources.transcriptId).then(() => undefined);
    const attempt = new InitializationAttempt(++this.initializationNumber);
    this.initialization = attempt;
    this.update({ initialization: attempt.snapshot, error: undefined });
    this.publish();
    if (attempt.running) {
      void this.loadInitial(attempt).then(
        () => {
          if (!attempt.running) return;
          attempt.complete();
          this.update({ initialization: attempt.snapshot });
          this.publish();
        },
        (error) => {
          if (!attempt.running) return;
          attempt.fail(error);
          if (this.initialization !== attempt) return;
          this.update({ initialization: attempt.snapshot, error });
          this.publish();
        },
      );
    }
    return attempt.promise;
  }

  private async loadInitial(attempt: InitializationAttempt): Promise<void> {
    await Promise.all([this.loadConfiguration(attempt), this.loadInitialTranscript(attempt)]);
    while (attempt.running) {
      const id = this.sources.transcriptId;
      const sync = id ? this.sources.transcripts.get(id)?.sync : undefined;
      if (sync?.status === 'live') return;
      if (id && (sync?.status === 'retrying' || sync?.status === 'connecting')) await this.transcripts.watch(id);
      else throw sync?.status === 'failed' ? sync.error : new Error('初始化结束前消息同步已停止。');
    }
  }

  private async loadConfiguration(attempt: InitializationAttempt): Promise<void> {
    if (this.sources.config) return;
    const config = await this.conversation.config();
    if (attempt.running) this.update({ config: Object.freeze({ ...config, ...(config.files ? { files: Object.freeze({ ...config.files }) } : {}) }) });
  }

  private async loadInitialTranscript(attempt: InitializationAttempt): Promise<void> {
    const locator = this.loadTracking();
    const catalog = acceptCatalog(await this.conversation.conversations());
    if (!attempt.running) return;
    const remembered = locator ? catalog.conversations.find((item) => item.id === locator.conversationId) : undefined;
    if (locator?.submissionId && !remembered) throw new Error('原提交所属对话已不可用，无法确认其结果。');
    const selected = remembered ?? catalog.conversations.find((item) => item.id === catalog.defaultConversationId)!;
    if (remembered && remembered.transcriptId !== locator!.transcriptId) throw new Error('保存的对话与当前消息集合身份不一致。');
    this.update({ conversations: catalog.conversations });
    this.openingTranscript = selected.transcriptId;
    const [, discovery] = await Promise.all([this.transcripts.watch(selected.transcriptId), locator?.submissionId ? Promise.resolve(undefined) : this.discoverSubmission(selected, attempt.signal)]);
    if (!attempt.running) return;
    this.openingTranscript = undefined;
    this.update({ conversation: selected, transcriptId: selected.transcriptId });
    this.interactions.setConversation(selected.id);
    if (!attempt.running) return;
    this.observation.setConversation(selected.id, selected.transcriptId);
    if (!attempt.running) return;
    if (locator?.submissionId) {
      const current = this.queue.submission;
      const submission = current?.id === locator.submissionId && current.conversationId === selected.id ? current : this.queue.attach({ conversationId: selected.id, submissionId: locator.submissionId }, selected.transcriptId);
      // The locator is not authority: query the original identity before following it.
      // Failure remains attached and blocks new dispatch; it never causes another POST.
      await this.queue.refresh(attempt.signal).catch(() => undefined);
      if (!attempt.running || this.queue.submission !== submission) return;
      if (submission.snapshot.remote && !submission.snapshot.remote.result && submission.snapshot.feedback.status !== 'unavailable') void this.queue.reconnect();
    } else if (discovery?.submission) {
      const baseline = discovery.submission;
      const current = this.queue.submission;
      if (current?.id !== baseline.submission.submissionId || current.conversationId !== selected.id) this.queue.attach({ conversationId: selected.id, submissionId: baseline.submission.submissionId }, selected.transcriptId, baseline);
      void this.queue.reconnect();
    }
    this.saveTracking();
  }

  private async discoverSubmission(target: ConversationDescriptor, signal?: AbortSignal): Promise<ConversationSubmissionDiscovery> {
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
    const discovery = await this.conversation.activeSubmission(target.id, requestSignal);
    requestSignal.throwIfAborted();
    if (!discovery || discovery.conversationId !== target.id || discovery.transcriptId !== target.transcriptId) throw new Error('活动提交查询返回了不同的对话或消息集合。');
    const baseline = discovery.submission;
    if (baseline && (baseline.type !== 'baseline' || baseline.submission.conversationId !== target.id || baseline.submission.result || (baseline.submission.input && baseline.submission.input.transcriptId !== target.transcriptId) || (baseline.submission.admission && baseline.submission.admission.transcriptId !== target.transcriptId))) throw new Error('活动提交与目标对话不一致。');
    // Validate before changing the selected conversation or closing its existing connections.
    if (baseline) ClientSubmission.attach({ conversationId: target.id, submissionId: baseline.submission.submissionId }, target.transcriptId, baseline);
    return discovery;
  }

  private loadTracking(): ClientTrackingLocator | undefined {
    if (this.trackingLoaded) return this.trackingLocator;
    this.trackingLoaded = true;
    try {
      const locator = this.tracking?.load();
      this.trackingLocator = locator === undefined ? undefined : acceptTrackingLocator(locator);
    } catch (trackingError) {
      this.update({ trackingError });
    }
    return this.trackingLocator;
  }

  /** Written synchronously before dispatch through submission's connecting notification. */
  private saveTracking(): void {
    const target = this.sources.conversation;
    if (!this.tracking || !target) return;
    const submission = this.queue.submission;
    if (submission && submission.conversationId !== target.id) return;
    const submissionId = submission?.dispatched && !submission.snapshot.remote?.result ? submission.id : undefined;
    const locator: ClientTrackingLocator = Object.freeze({ conversationId: target.id, transcriptId: target.transcriptId, ...(submissionId ? { submissionId } : {}) });
    if (this.trackingLocator?.conversationId === locator.conversationId && this.trackingLocator.transcriptId === locator.transcriptId && this.trackingLocator.submissionId === locator.submissionId) return;
    // A storage failure is reported once per locator transition, not on every progress delta.
    this.trackingLocator = locator;
    try {
      this.tracking.save(locator);
      if (this.sources.trackingError !== undefined) this.update({ trackingError: undefined });
    } catch (trackingError) {
      this.update({ trackingError });
    }
  }

  private get canSwitchConversation(): boolean {
    return this.sources.initialization.status === 'succeeded' && !this.sources.switching && this.queue.canSwitchConversation;
  }

  async refreshConversations(): Promise<void> {
    const request = ++this.catalogRequest;
    try {
      const catalog = acceptCatalog(await this.conversation.conversations());
      if (request !== this.catalogRequest) return;
      const selected = catalog.conversations.find((item) => item.id === this.sources.conversation?.id);
      if (selected && selected.transcriptId !== this.sources.transcriptId) throw new Error('已有对话的消息集合身份发生改变。');
      this.update({ conversations: catalog.conversations, ...(selected ? { conversation: selected } : {}), conversationError: undefined });
    } catch (conversationError) {
      if (request === this.catalogRequest) this.update({ conversationError });
      throw conversationError;
    }
  }

  private beginOpening(): number {
    if (this.sources.initialization.status !== 'succeeded' || !this.queue.canSwitchConversation) throw new Error('当前提交尚未结束或仍有待发送消息，暂不能切换对话。');
    const generation = ++this.opening;
    const abandoned = this.openingTranscript;
    this.openingTranscript = undefined;
    this.update({ switching: true, conversationError: undefined });
    if (abandoned && abandoned !== this.sources.transcriptId) this.transcripts.stop(abandoned);
    return generation;
  }

  async createConversation(): Promise<ConversationDescriptor> {
    if (!this.canSwitchConversation) throw new Error('当前不能新建对话，请等待当前处理结束。');
    const generation = this.beginOpening();
    try {
      const created = acceptDescriptor(await this.conversation.createConversation());
      this.upsertConversation(created);
      await this.activateConversation(created, generation);
      return created;
    } catch (conversationError) {
      this.failOpening(generation, conversationError);
      throw conversationError;
    }
  }

  async openConversation(id: string): Promise<void> {
    if (!id) throw new TypeError('对话身份不能为空。');
    if (id === this.sources.conversation?.id && !this.sources.switching) return;
    const generation = this.beginOpening();
    try {
      const target = acceptDescriptor(await this.conversation.conversation(id));
      if (target.id !== id) throw new Error('返回了不同的对话。');
      await this.activateConversation(target, generation);
    } catch (conversationError) {
      this.failOpening(generation, conversationError);
      throw conversationError;
    }
  }

  private upsertConversation(conversation: ConversationDescriptor): void {
    this.catalogRequest++;
    const existing = this.sources.conversations.find((item) => item.id === conversation.id);
    if (existing && existing.transcriptId !== conversation.transcriptId) throw new Error('已有对话的消息集合身份发生改变。');
    const conversations = [...this.sources.conversations.filter((item) => item.id !== conversation.id), conversation].sort((a, b) => b.updatedAt - a.updatedAt);
    this.update({ conversations: Object.freeze(conversations) });
  }

  private async activateConversation(target: ConversationDescriptor, generation: number): Promise<void> {
    if (generation !== this.opening) return;
    const previousId = this.sources.transcriptId;
    this.openingTranscript = target.transcriptId;
    const [, discovery] = await Promise.all([this.transcripts.watch(target.transcriptId), this.discoverSubmission(target)]);
    if (generation !== this.opening) return;
    const sync = this.sources.transcripts.get(target.transcriptId)?.sync;
    if (sync?.status !== 'live') throw sync?.status === 'failed' ? sync.error : new Error('目标对话的消息同步尚未就绪。');
    try {
      this.upsertConversation(target);
      this.queue.openConversation();
      if (generation !== this.opening) return;
      this.openingTranscript = undefined;
      this.acceptances.clear();
      this.update({ conversation: target, transcriptId: target.transcriptId, submission: undefined, submissions: new Map(), conversationError: undefined });
      this.interactions.setConversation(target.id);
      if (generation !== this.opening) return;
      this.observation.setConversation(target.id, target.transcriptId);
      if (generation !== this.opening) return;
      if (discovery.submission) {
        this.queue.attach({ conversationId: target.id, submissionId: discovery.submission.submission.submissionId }, target.transcriptId, discovery.submission);
        void this.queue.reconnect();
      }
      if (generation !== this.opening) return;
      this.update({ switching: false });
      this.saveTracking();
    } finally {
      if (previousId && previousId !== this.sources.transcriptId && previousId !== this.openingTranscript) this.transcripts.stop(previousId);
    }
  }

  private failOpening(generation: number, conversationError: unknown): void {
    if (generation !== this.opening) return;
    const candidate = this.openingTranscript;
    this.openingTranscript = undefined;
    this.update({ switching: false, conversationError });
    if (candidate && candidate !== this.sources.transcriptId) this.transcripts.stop(candidate);
  }

  /** Load an entity only when needed, then keep its copy current until explicitly stopped. */
  loadTranscript(id: string): Promise<import('@capix/protocol').TranscriptSnapshot> {
    return this.transcripts.watch(id);
  }

  stopTranscript(id?: string): void {
    const attempt = this.initialization;
    const stopsInitialization = attempt?.running && (!id || id === (this.sources.transcriptId ?? this.openingTranscript));
    this.transcripts.stop(id);
    if (stopsInitialization && attempt.running) {
      attempt.stop();
      if (this.initialization === attempt) this.update({ initialization: attempt.snapshot });
    }
    this.publish();
  }

  /** Explicitly enable live observation. Stopping it never cancels conversation work. */
  startObservation(): () => void {
    return this.observation.start();
  }

  async refreshObservation(): Promise<void> {
    this.observation.refresh();
  }

  getExecution(id: string): ExecutionRecordSnapshot | undefined {
    return this.observation.getExecution(id);
  }

  loadExecution(id: string, signal?: AbortSignal): Promise<ExecutionRecordSnapshot> {
    return this.observation.loadExecution(id, signal);
  }

  source(path: string, signal?: AbortSignal) {
    return this.observation.source(path, signal);
  }

  interactionLinks(callId: string, signal?: AbortSignal) {
    return this.interactions.links(callId, signal);
  }

  observeInteraction(callId: string, id: string, accept: (value: InteractionObservation) => void, signal: AbortSignal): Promise<void> {
    return this.interactions.observe(callId, id, accept, signal);
  }

  private updateSubmission(submission?: ClientSubmission): void {
    if (this.queue.submission !== submission) return;
    if (submission?.acceptancePending) this.acceptances.add(submission);
    let submissions = this.sources.submissions;
    if (submission?.dispatched && submissions.get(submission.id) !== submission.snapshot) {
      const retained = new Map(submissions);
      retained.set(submission.id, submission.snapshot);
      // Keep only snapshots, not old connections, mutable calls or input request bodies.
      for (const id of retained.keys()) {
        if (retained.size <= 32) break;
        if (id !== submission.id) retained.delete(id);
      }
      submissions = retained;
    }
    this.update({ submission: submission?.snapshot, submissions, queue: this.queue.snapshot });
    this.saveTracking();
    if (submission?.snapshot.remote?.result && this.catalogRefreshSubmission !== submission.id) {
      this.catalogRefreshSubmission = submission.id;
      void this.refreshConversations().catch(() => undefined);
    }
  }

  /** Local acceptance is synchronous; it does not claim service admission or completion. */
  enqueue(request: ConversationRequest): { readonly id: string } {
    const receipt = this.queue.enqueue(request);
    this.publish();
    return receipt;
  }

  /** Immediate send, without jumping the queue. Promise completion belongs to feedback only. */
  async submit(request: ConversationRequest, accepted?: (submission: ClientSubmissionState) => undefined): Promise<void> {
    this.publish();
    const submission = this.queue.prepare(request, accepted);
    this.publish();
    await this.queue.send(submission);
  }

  clearQueue(): void {
    this.queue.clear();
    this.publish();
  }

  cancelSubmission(id: string): Promise<void> {
    const cancellation = this.queue.cancel(id);
    this.publish();
    return cancellation;
  }

  cancelAll(): Promise<void> {
    const cancellation = this.queue.cancelAll();
    this.publish();
    return cancellation;
  }

  reconnectSubmission(): Promise<void> {
    this.publish();
    return this.queue.reconnect();
  }

  refreshSubmission(): Promise<void> {
    return this.queue.refresh();
  }

  stopFollowing(): void {
    this.queue.stopFollowing();
    this.publish();
  }

  /** Unknown remote work cannot be discarded to release the local queue. */
  releaseSubmission(): void {
    this.queue.release();
    this.publish();
  }

  /** Explicitly end unavailable local tracking; this makes no claim about remote effects. */
  abandonSubmission(): void {
    this.queue.abandon();
    this.saveTracking();
    this.publish();
  }
}

function acceptDescriptor(value: ConversationDescriptor): ConversationDescriptor {
  if (!value || typeof value.id !== 'string' || !value.id || typeof value.title !== 'string' || typeof value.transcriptId !== 'string' || !value.transcriptId || !Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt) || value.createdAt < 0 || value.updatedAt < value.createdAt) throw new TypeError('对话信息格式无效。');
  return Object.freeze({ id: value.id, title: value.title, transcriptId: value.transcriptId, createdAt: value.createdAt, updatedAt: value.updatedAt });
}

function acceptCatalog(value: ConversationListResponse): ConversationListResponse {
  if (!value || !Array.isArray(value.conversations)) throw new TypeError('对话列表格式无效。');
  const conversations = Object.freeze(value.conversations.map(acceptDescriptor));
  if (!conversations.some((item) => item.id === value.defaultConversationId) || new Set(conversations.map((item) => item.id)).size !== conversations.length || new Set(conversations.map((item) => item.transcriptId)).size !== conversations.length) throw new TypeError('对话列表身份关联无效。');
  return Object.freeze({ conversations, defaultConversationId: value.defaultConversationId });
}
