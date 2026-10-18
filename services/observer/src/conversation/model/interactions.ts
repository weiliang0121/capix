import { z } from 'zod';
import { isEqual } from 'es-toolkit/predicate';
import { Interaction, InvocationCancelled, RuntimeError, ProgressChannel, isInvocationCancelled, type InteractionContract, type InteractionFact, type InteractionPersistence, type InteractionState, type ProgressReceiver } from '@capix/server-runtime';
import { ModelSource } from './source.js';
import type { ModelOutput, ModelRequest, ModelTextDelta, Purpose } from './types.js';
import { ModelTextBuffer } from './stream.js';

export interface ModelInteractionRequest {
  readonly request: ModelRequest;
  readonly purpose: Purpose;
  readonly timeoutMs: number;
}
export interface ModelInteractionRef {
  readonly id: string;
}
export interface ModelInteractionControls {
  readonly timeoutMs: number;
}
export type ModelInteractionResult = { readonly kind: 'received'; readonly interaction: ModelInteractionRef; readonly output: ModelOutput } | { readonly kind: 'pending'; readonly interaction: ModelInteractionRef };
export interface ModelInteractionCreator {
  start(request: ModelRequest, purpose: Purpose, controls: ModelInteractionControls): ModelInteractionRef;
}
export interface ModelInteractionExpectation {
  readonly request: ModelRequest;
  readonly purpose: Purpose;
}
export interface ModelInteractionReader {
  /** Replay the retained prefix synchronously, then receive this exchange's raw increments. */
  subscribe(interaction: ModelInteractionRef, receiver: ProgressReceiver<ModelTextDelta>): () => void;
  wait(interaction: ModelInteractionRef, controls: { readonly signal: AbortSignal; readonly waitMs: number }): Promise<ModelInteractionResult>;
  result(interaction: ModelInteractionRef, controls: { readonly signal: AbortSignal; readonly expected?: ModelInteractionExpectation }): Promise<ModelOutput>;
}
export interface ModelInteractionPersistence extends InteractionPersistence<ModelInteractionRequest, ModelOutput> {
  read(id: string): InteractionState<unknown, unknown> | undefined;
}

export const modelRequestSchema = z.strictObject({ model: z.string(), messages: z.array(z.strictObject({ role: z.enum(['system', 'user', 'assistant']), content: z.string() })), response_format: z.strictObject({ type: z.literal('json_object') }), thinking: z.strictObject({ type: z.literal('disabled') }), max_tokens: z.int().positive(), stream: z.boolean() });
export const modelOutputSchema = z.strictObject({ id: z.string(), model: z.string(), content: z.string(), finishReason: z.string(), usage: z.strictObject({ promptTokens: z.int().nonnegative(), completionTokens: z.int().nonnegative(), totalTokens: z.int().nonnegative() }).nullable() });

const requestSchema = z.strictObject({
  request: modelRequestSchema,
  purpose: z.enum(['selection', 'understanding', 'answer', 'memory']),
  timeoutMs: z.int().positive().max(2_147_483_647),
});

/** The stored feedback is the provider envelope, before any business JSON acceptance. */
export const modelInteractionContract: InteractionContract<ModelInteractionRequest, ModelOutput> = Object.freeze({ key: 'observer.model.v1', request: (value: unknown) => requestSchema.parse(value), reply: (value: unknown) => modelOutputSchema.parse(value) });

/** Independent external exchanges. An A owns its wait, never this entity or its dispatch. */
export class ModelInteractions {
  readonly #interactions = new Map<string, Interaction<ModelInteractionRequest, ModelOutput>>();
  readonly #active = new Set<Interaction<ModelInteractionRequest, ModelOutput>>();
  readonly #streams = new Map<string, ModelTextBuffer>();
  readonly #observers = new Map<string, Set<ProgressChannel<InteractionFact<ModelInteractionRequest, ModelOutput>>>>();
  readonly #retained: number;
  #closed = false;

  constructor(
    readonly source: ModelSource,
    private readonly options: { readonly persistence?: ModelInteractionPersistence; readonly retained?: number } = {},
  ) {
    this.#retained = options.retained ?? 128;
    if (!Number.isSafeInteger(this.#retained) || this.#retained < 1) throw new RangeError('Model interaction retention must be a positive integer');
  }

  get active(): boolean {
    return this.#active.size > 0;
  }

  /** Host-only shutdown coordination. It neither resends nor abandons running exchanges. */
  async settled(): Promise<void> {
    await Promise.all([...this.#active].map((interaction) => interaction.settled()));
  }

  close(): void {
    if (this.active) throw new RuntimeError('MODEL_INTERACTIONS_ACTIVE', '仍有模型交互正在进行，不能关闭交互宿主。');
    this.#closed = true;
    this.#interactions.clear();
    this.#observers.clear();
    this.#streams.clear();
  }

  states(): readonly InteractionState<ModelInteractionRequest, ModelOutput>[] {
    return [...this.#interactions.values()].map((interaction) => interaction.exportState());
  }

  /** Raw progress belongs to the exchange; ending an A wait does not close this subscription. */
  subscribe(ref: ModelInteractionRef, receiver: ProgressReceiver<ModelTextDelta>): () => void {
    const interaction = this.get(ref);
    const stream = this.#streams.get(ref.id);
    if (stream) return stream.subscribe(receiver);
    if (interaction.exportState().request.request.stream) {
      const unavailable = new ProgressChannel<ModelTextDelta>({
        receive: () => {
          throw new RuntimeError('MODEL_STREAM_UNAVAILABLE', '该模型交互没有可恢复的临时输出；完整反馈仍可独立读取。');
        },
        failed: receiver.failed?.bind(receiver),
      });
      unavailable.publish({ text: '' });
    }
    return () => {};
  }

  /** Host observation is read-only and never initializes a provider or sends a request. */
  observe(ref: ModelInteractionRef, receiver: ProgressReceiver<InteractionFact<ModelInteractionRequest, ModelOutput>>) {
    const interaction = this.get(ref);
    const observer = new ProgressChannel(receiver);
    const observers = this.#observers.get(ref.id) ?? new Set();
    observers.add(observer);
    this.#observers.set(ref.id, observers);
    return {
      state: interaction.exportState(),
      result: interaction.read(),
      retained: this.options.persistence ? ('persistent' as const) : ('memory' as const),
      close: () => {
        observers.delete(observer);
        if (!observers.size) this.#observers.delete(ref.id);
      },
    };
  }

  start(request: ModelRequest, purpose: Purpose, controls: ModelInteractionControls): ModelInteractionRef {
    this.requireOpen();
    // Provider construction must fail before an exchange is registered as dispatched.
    const provider = this.source.get();
    const interaction = new Interaction({ request, purpose, timeoutMs: controls.timeoutMs }, { contract: modelInteractionContract, persistence: this.options.persistence, observation: { receive: (fact) => this.publish(fact) } });
    const ref = Object.freeze({ id: interaction.id });
    this.#interactions.set(interaction.id, interaction);
    const signal = AbortSignal.timeout(controls.timeoutMs);
    const stream = request.stream ? new ModelTextBuffer() : undefined;
    if (stream) this.#streams.set(interaction.id, stream);
    const progress = stream
      ? new ProgressChannel<ModelTextDelta>({
          receive: (delta) => {
            if (!signal.aborted) stream.progress.publish(delta);
          },
        })
      : undefined;
    this.#active.add(interaction);
    try {
      interaction.start(async (fixed) => {
        try {
          if (signal.aborted) throw signal.reason;
          const output = await provider.invoke(fixed.request, fixed.purpose, signal, progress);
          if (signal.aborted) throw signal.reason;
          return output;
        } catch (error) {
          if (!isInvocationCancelled(error, signal) && !(signal.aborted && error === signal.reason)) throw error;
          throw new RuntimeError('MODEL_TIMEOUT', '模型调用超过时限。', undefined, { cause: error });
        } finally {
          stream?.finish();
        }
      });
    } catch (error) {
      stream?.finish();
      this.#active.delete(interaction);
      throw error;
    }
    void interaction.settled().then(() => {
      this.#active.delete(interaction);
      this.prune();
    });
    return ref;
  }

  async wait(ref: ModelInteractionRef, controls: { readonly signal: AbortSignal; readonly waitMs: number }): Promise<ModelInteractionResult> {
    const interaction = this.get(ref);
    try {
      const result = await interaction.wait(controls);
      if (controls.signal.aborted) throw controls.signal.reason;
      if (result.kind === 'received') return { kind: 'received', interaction: ref, output: result.feedback.payload };
      if (result.kind === 'unavailable') throw result.error;
      return { kind: 'pending', interaction: ref };
    } catch (error) {
      if (!controls.signal.aborted || error !== controls.signal.reason) throw error;
      return this.cancelled(interaction, controls.signal, error);
    }
  }

  async result(ref: ModelInteractionRef, controls: { readonly signal: AbortSignal; readonly expected?: ModelInteractionExpectation }): Promise<ModelOutput> {
    const interaction = this.get(ref);
    const fixed = interaction.exportState().request;
    if (controls.expected && (fixed.purpose !== controls.expected.purpose || !isEqual(fixed.request, controls.expected.request))) throw new RuntimeError('MODEL_INTERACTION_MISMATCH', '保存的模型交互不属于本次固定请求；不能读取其他调用的反馈。');
    try {
      await waitForSettlement(interaction, controls.signal);
    } catch (error) {
      if (!controls.signal.aborted || error !== controls.signal.reason) throw error;
      return this.cancelled(interaction, controls.signal, error);
    }
    const result = interaction.read();
    if (result.kind === 'unavailable') throw result.error;
    if (controls.signal.aborted) throw new InvocationCancelled(controls.signal);
    if (result.kind !== 'received') throw new RuntimeError('MODEL_INTERACTION_PENDING', '模型交互尚未取得可接纳的反馈。');
    return result.feedback.payload;
  }

  private cancelled(interaction: Interaction<ModelInteractionRequest, ModelOutput>, signal: AbortSignal, error: unknown): never {
    // Only failures already available to this reader take precedence over its local stop.
    // A later dispatch result belongs to the independent interaction, never this ended wait.
    const result = interaction.read();
    if (result.kind === 'unavailable' && !isInvocationCancelled(result.error, signal)) throw result.error;
    throw new InvocationCancelled(signal, { cause: error });
  }

  private get(ref: ModelInteractionRef): Interaction<ModelInteractionRequest, ModelOutput> {
    this.requireOpen();
    let interaction = this.#interactions.get(ref.id);
    if (!interaction) {
      const saved = this.options.persistence?.read(ref.id);
      if (saved) {
        interaction = Interaction.restore(saved, { contract: modelInteractionContract, persistence: this.options.persistence });
        if (interaction.id !== ref.id) throw new RuntimeError('MODEL_INTERACTION_IDENTITY', '保存的模型交互身份与查询身份不一致。');
        this.#interactions.set(interaction.id, interaction);
        this.prune();
      }
    }
    if (!interaction) throw new RuntimeError('MODEL_INTERACTION_UNKNOWN', '找不到指定的模型交互；不能据此重新发送请求。');
    return interaction;
  }

  private requireOpen(): void {
    if (this.#closed) throw new RuntimeError('MODEL_INTERACTIONS_CLOSED', '模型交互宿主已经关闭。');
  }

  private publish(fact: InteractionFact<ModelInteractionRequest, ModelOutput>): undefined {
    for (const observer of [...(this.#observers.get(fact.state.id) ?? [])]) observer.publish(fact);
  }

  private prune(): void {
    let completed = this.#interactions.size - this.#active.size;
    for (const [id, interaction] of this.#interactions) {
      if (completed <= this.#retained) return;
      if (this.#active.has(interaction)) continue;
      this.#interactions.delete(id);
      this.#streams.delete(id);
      completed -= 1;
    }
  }
}

function waitForSettlement(interaction: Interaction<ModelInteractionRequest, ModelOutput>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const cancel = () => {
      signal.removeEventListener('abort', cancel);
      reject(signal.reason);
    };
    signal.addEventListener('abort', cancel, { once: true });
    void interaction.settled().then(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    });
  });
}
