import { ProgressChannel, RuntimeError, type ProgressReceiver } from '@capix/server-runtime';
import type { ModelTextDelta } from './types.js';

export const modelTextByteLimit = 4 * 1024 * 1024;

type StreamFact = { readonly kind: 'delta'; readonly delta: ModelTextDelta } | { readonly kind: 'failed'; readonly error: unknown };

/** Transient raw prefix and passive consumers for one host-owned exchange. */
export class ModelTextBuffer {
  readonly progress = new ProgressChannel<ModelTextDelta>({ receive: (delta) => this.append(delta), failed: (error) => this.fail(error) });
  private readonly chunks: string[] = [];
  private readonly receivers = new Set<ProgressChannel<StreamFact>>();
  private length = 0;
  private ended = false;
  private failure: { readonly error: unknown } | undefined;

  subscribe(receiver: ProgressReceiver<ModelTextDelta>): () => void {
    const channel = new ProgressChannel<StreamFact>({
      receive: (fact) => {
        if (fact.kind === 'failed') throw fact.error;
        return receiver.receive(fact.delta);
      },
      failed: receiver.failed?.bind(receiver),
    });
    if (this.failure) channel.publish({ kind: 'failed', error: this.failure.error });
    else {
      this.receivers.add(channel);
      if (this.chunks.length) channel.publish({ kind: 'delta', delta: Object.freeze({ text: this.chunks.join('') }) });
      if (channel.failure) this.receivers.delete(channel);
    }
    return () => {
      this.receivers.delete(channel);
    };
  }

  finish(): void {
    this.ended = true;
    this.receivers.clear();
  }

  private append(delta: ModelTextDelta): undefined {
    if (this.ended || this.failure) return;
    if (!delta || typeof delta.text !== 'string') throw new TypeError('Model progress requires a text delta');
    if (!delta.text) return;
    const length = Buffer.byteLength(delta.text, 'utf8');
    if (this.length + length > modelTextByteLimit) {
      this.fail(new RuntimeError('MODEL_STREAM_LIMIT', '模型临时输出超过本地接收容量。'));
      return;
    }
    this.length += length;
    this.chunks.push(delta.text);
    const fact: StreamFact = { kind: 'delta', delta: Object.freeze({ text: delta.text }) };
    for (const receiver of [...this.receivers]) {
      receiver.publish(fact);
      if (receiver.failure) this.receivers.delete(receiver);
    }
  }

  private fail(error: unknown): undefined {
    if (this.failure) return;
    this.failure = Object.freeze({ error });
    this.chunks.length = 0;
    for (const receiver of this.receivers) receiver.publish({ kind: 'failed', error });
    this.receivers.clear();
  }
}
