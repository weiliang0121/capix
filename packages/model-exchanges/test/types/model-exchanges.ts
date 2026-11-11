// @ts-expect-error the old scope supply alias is no longer part of the public contract
import type { ModelExchangeSupply } from '@weiliang0121/capix-model-exchanges';
import { ModelExchanges, ModelExchangeResource, ModelExchangeViewSource, type ExchangeOriginReference, type ModelExchangeBasis, type ModelExchangeOrigin, type ExchangeReference, type ExchangeIntakeReceipt, type ExchangeFeedbackReceipt, type ModelExchangeEntry, type ModelExchangesPersistence } from '@weiliang0121/capix-model-exchanges';
import { Resources, Resource } from '@weiliang0121/capix-resources';
import type { ModelReply, ModelRequest, ToolResult } from '@weiliang0121/capix-model-provider';
import type { SyncViewSource } from '@weiliang0121/capix-view';

declare function expectType<Value>(value: Value): void;
declare const reply: ModelReply;
declare const result: ToolResult;
declare const basis: ModelExchangeBasis;
const persistence: ModelExchangesPersistence = {
  commit(change) {
    expectType<number>(change.expectedSequence);
    if (change.kind === 'origin') expectType<ModelExchangeOrigin>(change.origin);
    else expectType<ModelExchangeEntry>(change.entry);
    return undefined;
  },
};
const exchanges = new ModelExchanges({ persistence });
const access = new Resources().register(new Resource(exchanges), ModelExchangeResource).bind({ exchanges: ModelExchangeResource.request() }).open();
const port = access.endpoints.exchanges;
const origin = port.begin('origin', basis);
expectType<ExchangeOriginReference>(origin);
expectType<ModelExchangeOrigin>(port.origin(origin));
const receipt = port.intake(origin, reply);
expectType<ExchangeIntakeReceipt>(receipt);
expectType<ExchangeFeedbackReceipt>(port.receive(origin, receipt.reference, 'a', result));
expectType<ExchangeReference>(port.complete(origin, receipt.reference, 'a', result));
expectType<ModelExchangeEntry>(port.read(origin, receipt.reference));
expectType<ModelRequest>(port.request({ origin, exchanges: [receipt.reference] }));
expectType<SyncViewSource<string, unknown, ModelExchangeEntry>>(new ModelExchangeViewSource(exchanges, origin));
// @ts-expect-error readonly references cannot be moved to another collection
receipt.reference.collection = 'other';
// @ts-expect-error provenance is obtained by the resource, not supplied by a business author
port.intake(origin, reply, { parentContextId: 'forged', childContextId: 'forged' });
// @ts-expect-error feedback shape preserves status instead of treating failures as text
port.complete(origin, receipt.reference, 'a', 'failed');
// @ts-expect-error reference identity is required; the model tool ID is not an exchange reference
port.read(origin, 'a');
// @ts-expect-error asynchronous persistence cannot meet the synchronous commit contract
const invalid: ModelExchangesPersistence = { commit: async () => undefined };
// @ts-expect-error caller scope strings cannot replace fixed origins
exchanges.intake('scope', { parentContextId: 'a', childContextId: 'b', position: 'c' }, reply);
// @ts-expect-error direct source has no caller selected scope wrapper
new Resources().register(new Resource({ exchanges, scope: 'scope' }), ModelExchangeResource);
// @ts-expect-error prefix exchanges require references, not complete entries
port.request({ origin, exchanges: exchanges.values() });
// @ts-expect-error an exchange reference is not an origin reference
port.origin(receipt.reference);
// @ts-expect-error catalog tools cannot be overridden by the request basis
port.begin('override', { ...basis, request: { ...basis.request, tools: [] } });
void invalid;

// @ts-expect-error historical requests cannot override fixed messages
port.request({ origin, exchanges: [], messages: [{ role: 'user', content: 'override' }] });
