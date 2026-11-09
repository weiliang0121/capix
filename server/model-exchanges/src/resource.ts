import { ResourceOffer } from '@weiliang0121/capix-resources';
import type { ModelReply, ToolResult } from '@weiliang0121/capix-model-provider';
import type { ModelExchanges } from './exchanges.js';
import type { ExchangeFeedbackReceipt, ExchangeIntakeReceipt, ExchangeReference } from './types.js';
import { feedbackDigest, identity, requireExchangeOperation } from './value.js';

export interface ModelExchangeSupply {
  readonly exchanges: ModelExchanges;
  readonly scope: string;
}

/** Reception provenance is acquired here; business code never supplies parent/child IDs. */
export const ModelExchangeResource = new ResourceOffer({
  name: 'model-exchanges',
  timing: 'access',
  expose: ({ exchanges, scope }: ModelExchangeSupply, activity) => {
    scope = identity(scope);
    return Object.freeze({
      intake(reply: ModelReply): ExchangeIntakeReceipt {
        return activity.runSync('intake', {}, () => {
          const operation = requireExchangeOperation({ ...activity.reception(), position: 'model-reply' });
          return Object.freeze({ reference: exchanges.intake(scope, operation, reply), operation });
        });
      },
      read(reference: ExchangeReference) {
        return activity.runSync('read', {}, () => exchanges.read(scope, reference, false));
      },
      closed(references: readonly ExchangeReference[]) {
        return activity.runSync('closed', {}, () => exchanges.closed(scope, references));
      },
      receive(reference: ExchangeReference, callId: string, result: ToolResult): ExchangeFeedbackReceipt {
        return activity.runSync('receive', {}, () => {
          const operation = requireExchangeOperation({ ...activity.reception(), position: 'tool-feedback' });
          const next = exchanges.complete(scope, reference, callId, result, operation);
          const feedback = exchanges.read(scope, next).feedback.find((item) => item.toolCallId === callId)!;
          return Object.freeze({ reference: next, operation, feedbackDigest: feedbackDigest(feedback) });
        });
      },
      // Precheck feedback has no child relation. It must not invent reception provenance.
      complete(reference: ExchangeReference, callId: string, result: ToolResult) {
        return activity.runSync('complete', {}, () => exchanges.complete(scope, reference, callId, result));
      },
    });
  },
});
