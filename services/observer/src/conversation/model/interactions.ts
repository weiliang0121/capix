import { z } from 'zod';
import { Interaction, InvocationCancelled, RuntimeError, isInvocationCancelled, type InteractionContract, type InteractionPersistence, type InteractionState } from '@capix/server-runtime';
import { ModelSource } from './source.js';
import type { ModelOutput, ModelRequest, Purpose } from './types.js';

export interface ModelInteractionRequest {
  readonly request: ModelRequest;
  readonly purpose: Purpose;
  readonly timeoutMs: number;
}
export interface ModelInteractionRef {
  readonly id: string;
}
export type ModelInteractionResult = { readonly kind: 'received'; readonly interaction: ModelInteractionRef; readonly output: ModelOutput } | { readonly kind: 'pending'; readonly interaction: ModelInteractionRef };
export interface ModelInteractionCreator {
  start(request: ModelRequest, purpose: Purpose, controls: { readonly signal: AbortSignal; readonly timeoutMs: number }): ModelInteractionRef;
}
export interface ModelInteractionReader {
  wait(interaction: ModelInteractionRef, controls: { readonly signal: AbortSignal; readonly waitMs: number }): Promise<ModelInteractionResult>;
  result(interaction: ModelInteractionRef, controls: { readonly signal: AbortSignal }): Promise<ModelOutput>;
}
export interface ModelInteractionPersistence extends InteractionPersistence<ModelInteractionRequest, ModelOutput> {
  read(id: string): InteractionState<unknown, unknown> | undefined;
}

const requestSchema = z.strictObject({
  request: z.strictObject({ model: z.string(), messages: z.array(z.strictObject({ role: z.enum(['system', 'user', 'assistant']), content: z.string() })), response_format: z.strictObject({ type: z.literal('json_object') }), thinking: z.strictObject({ type: z.literal('disabled') }), max_tokens: z.int().positive(), stream: z.literal(false) }),
  purpose: z.enum(['selection', 'understanding', 'answer', 'memory']),
  timeoutMs: z.int().positive().max(2_147_483_647),
});
const outputSchema = z.strictObject({ id: z.string(), model: z.string(), content: z.string(), finishReason: z.string(), usage: z.strictObject({ promptTokens: z.int().nonnegative(), completionTokens: z.int().nonnegative(), totalTokens: z.int().nonnegative() }).nullable() });

/** The stored feedback is the provider envelope, before any business JSON acceptance. */
export const modelInteractionContract: InteractionContract<ModelInteractionRequest, ModelOutput> = Object.freeze({ key: 'observer.model.v1', request: (value: unknown) => requestSchema.parse(value), reply: (value: unknown) => outputSchema.parse(value) });

/** Independent external exchanges. An A owns its wait, never this entity or its dispatch. */
export class ModelInteractions {
  readonly #interactions = new Map<string, Interaction<ModelInteractionRequest, ModelOutput>>();
  readonly #active = new Set<Interaction<ModelInteractionRequest, ModelOutput>>();
  readonly #signals = new Map<string, AbortSignal>();
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

  /** A cancelled host may still be draining an external call after its REOA invocation ended. */
  get cancelling(): boolean {
    return [...this.#signals.values()].some((signal) => signal.aborted);
  }

  /** Host-only shutdown coordination. It neither resends nor abandons running exchanges. */
  async settled(options: { readonly owner?: AbortSignal } = {}): Promise<void> {
    await Promise.all([...this.#active].filter((interaction) => options.owner === undefined || this.#signals.get(interaction.id) === options.owner).map((interaction) => interaction.settled()));
  }

  close(): void {
    if (this.active) throw new RuntimeError('MODEL_INTERACTIONS_ACTIVE', '仍有模型交互正在进行，不能关闭交互宿主。');
    this.#closed = true;
    this.#interactions.clear();
  }

  states(): readonly InteractionState<ModelInteractionRequest, ModelOutput>[] {
    return [...this.#interactions.values()].map((interaction) => interaction.exportState());
  }

  start(request: ModelRequest, purpose: Purpose, controls: { readonly signal: AbortSignal; readonly timeoutMs: number }): ModelInteractionRef {
    this.requireOpen();
    if (controls.signal.aborted) throw new InvocationCancelled(controls.signal);
    // Provider construction must fail before an exchange is registered as dispatched.
    const provider = this.source.get();
    const interaction = new Interaction({ request, purpose, timeoutMs: controls.timeoutMs }, { contract: modelInteractionContract, persistence: this.options.persistence });
    this.#interactions.set(interaction.id, interaction);
    const timeout = AbortSignal.timeout(controls.timeoutMs);
    const signal = AbortSignal.any([controls.signal, timeout]);
    this.#active.add(interaction);
    this.#signals.set(interaction.id, controls.signal);
    try {
      interaction.start(async (fixed) => {
        try {
          if (signal.aborted) throw signal.reason;
          const output = await provider.invoke(fixed.request, fixed.purpose, signal);
          if (signal.aborted) throw signal.reason;
          return output;
        } catch (error) {
          if (!isInvocationCancelled(error, signal) && !(signal.aborted && error === signal.reason)) throw error;
          if (controls.signal.aborted && signal.reason === controls.signal.reason) throw new InvocationCancelled(controls.signal, { cause: error });
          if (timeout.aborted && signal.reason === timeout.reason) throw new RuntimeError('MODEL_TIMEOUT', '模型调用超过时限。', undefined, { cause: error });
          throw error;
        }
      });
    } catch (error) {
      this.#active.delete(interaction);
      this.#signals.delete(interaction.id);
      throw error;
    }
    void interaction.settled().then(() => {
      this.#active.delete(interaction);
      this.#signals.delete(interaction.id);
      this.prune();
    });
    return Object.freeze({ id: interaction.id });
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

  async result(ref: ModelInteractionRef, controls: { readonly signal: AbortSignal }): Promise<ModelOutput> {
    const interaction = this.get(ref);
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

  private async cancelled(interaction: Interaction<ModelInteractionRequest, ModelOutput>, signal: AbortSignal, error: unknown): Promise<never> {
    // Only the dispatch owner's cancellation joins its external cleanup. An independent reader can leave immediately.
    if (this.#signals.get(interaction.id) === signal) await interaction.settled();
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

  private prune(): void {
    let completed = this.#interactions.size - this.#active.size;
    for (const [id, interaction] of this.#interactions) {
      if (completed <= this.#retained) return;
      if (this.#active.has(interaction)) continue;
      this.#interactions.delete(id);
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
