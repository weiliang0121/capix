import { ModelExchanges, ModelExchangeResource, ModelExchangeViewSource, type ExchangeReference, type ExchangeIntakeReceipt, type ExchangeFeedbackReceipt, type ModelExchangeEntry, type ModelExchangesPersistence } from '@capix/model-exchanges';
import { Resources, Resource } from '@capix/resources';
import type { ModelReply, ToolResult } from '@capix/model-provider';
import type { SyncViewSource } from '@capix/view';

declare function expectType<Value>(value: Value): void;
declare const reply: ModelReply;
declare const result: ToolResult;
const persistence: ModelExchangesPersistence = {
  commit(change) {
    expectType<number>(change.expectedSequence);
    expectType<ModelExchangeEntry>(change.entry);
    return undefined;
  },
};
const exchanges = new ModelExchanges({ persistence });
const access = new Resources()
  .register(new Resource({ exchanges, scope: 'scope' }), ModelExchangeResource)
  .bind({ exchanges: ModelExchangeResource.request() })
  .open();
const receipt = access.endpoints.exchanges.intake(reply);
expectType<ExchangeIntakeReceipt>(receipt);
expectType<ExchangeFeedbackReceipt>(access.endpoints.exchanges.receive(receipt.reference, 'a', result));
expectType<ExchangeReference>(access.endpoints.exchanges.complete(receipt.reference, 'a', result));
expectType<ModelExchangeEntry>(access.endpoints.exchanges.read(receipt.reference));
expectType<SyncViewSource<string, unknown, ModelExchangeEntry>>(new ModelExchangeViewSource(exchanges));
// @ts-expect-error readonly references cannot be moved to another collection
receipt.reference.collection = 'other';
// @ts-expect-error provenance is obtained by the resource, not supplied by a business author
access.endpoints.exchanges.intake(reply, { parentContextId: 'forged', childContextId: 'forged' });
// @ts-expect-error feedback shape preserves status instead of treating failures as text
access.endpoints.exchanges.complete(receipt.reference, 'a', 'failed');
// @ts-expect-error reference identity is required; the model tool ID is not an exchange reference
access.endpoints.exchanges.read('a');
// @ts-expect-error asynchronous persistence cannot meet the synchronous commit contract
const invalid: ModelExchangesPersistence = { commit: async () => undefined };
void invalid;
