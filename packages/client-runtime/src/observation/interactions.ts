import type { CallInteractionLinks, InteractionObservation } from '@weiliang0121/capix-protocol';
import type { ObservationTransport } from '../transport.js';

/** On-demand entity observation has its own connection lifetime and follows the selected conversation. */
export class InteractionObserver {
  private scope?: { readonly id: string };
  private readonly requests = new Set<AbortController>();

  constructor(private readonly transport?: ObservationTransport) {}

  setConversation(id: string): void {
    if (id === this.scope?.id) return;
    const previous = [...this.requests];
    this.requests.clear();
    this.scope = { id };
    for (const request of previous) request.abort();
  }

  links(callId: string, signal?: AbortSignal): Promise<CallInteractionLinks> {
    return this.request(signal, async (conversationId, owned) => {
      if (!this.transport?.interactions) throw new Error('当前服务未提供外部交互观测。');
      const links = await this.transport.interactions(conversationId, callId, owned);
      if (links.callId !== callId || !Array.isArray(links.interactionIds) || links.interactionIds.some((id) => typeof id !== 'string' || !id) || new Set(links.interactionIds).size !== links.interactionIds.length) throw new Error('交互关联与请求的调用不一致。');
      return Object.freeze({ callId, interactionIds: Object.freeze([...links.interactionIds]) });
    });
  }

  observe(callId: string, id: string, accept: (value: InteractionObservation) => void, signal: AbortSignal): Promise<void> {
    return this.request(signal, async (conversationId, owned) => {
      if (!this.transport?.observeInteraction) throw new Error('当前服务未提供外部交互观测。');
      let previous: InteractionObservation | undefined;
      await this.transport.observeInteraction(
        conversationId,
        callId,
        id,
        (value) => {
          owned.throwIfAborted();
          if (value.id !== id || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error('交互观测身份或修订无效。');
          if (previous) {
            if (previous.result.kind !== 'pending' || value.contract !== previous.contract || value.model !== previous.model || value.purpose !== previous.purpose || value.retained !== previous.retained || value.revision < previous.revision || (previous.delivery === 'started' && value.delivery !== 'started')) throw new Error('交互观测发生不一致的状态变化。');
            if (value.revision === previous.revision && (value.delivery !== previous.delivery || value.result.kind !== 'unavailable')) throw new Error('交互修订未推进。');
          }
          previous = Object.freeze({ ...value, result: Object.freeze({ ...value.result }) });
          accept(previous);
        },
        owned,
      );
      if (!previous || previous.result.kind === 'pending') throw new Error('交互观测在取得最终状态前结束。');
    });
  }

  private async request<Result>(signal: AbortSignal | undefined, work: (conversationId: string, signal: AbortSignal) => Promise<Result>): Promise<Result> {
    const scope = this.scope;
    if (!scope) throw new Error('尚未选择对话。');
    const controller = new AbortController();
    const owned = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    this.requests.add(controller);
    try {
      owned.throwIfAborted();
      const result = await work(scope.id, owned);
      owned.throwIfAborted();
      if (this.scope !== scope) throw new Error('交互观测所属对话已切换。');
      return result;
    } finally {
      this.requests.delete(controller);
    }
  }
}
