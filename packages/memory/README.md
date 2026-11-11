# @weiliang0121/capix-memory

Independent, revisable summaries and controlled resource access for CAPiX. A collection does not require a Transcript, topic, message sources, or file receipts.

ES modules and TypeScript declarations. Requires Node.js 22.23.2 or newer.

```sh
npm install @weiliang0121/capix-memory
```

## Public entry points

- `@weiliang0121/capix-memory`

This package is part of CAPiX. The npm distribution contains compiled JavaScript, type declarations, and this package's MIT license. Reference services and client applications are not included in this package or the initial npm release.

## Content and current reads

`Memories<Metadata = never>` is the only write owner. Each immutable `MemoryItem` has an independent UUID and a `value: { content: string; metadata?: Metadata }`. Updating an item preserves its ID and replaces the entire value, including optional metadata. Selection, extraction, source validation, and retention belong to the application.

```ts
import { Memories, memoryResources } from '@weiliang0121/capix-memory';
import { Resource, Resources } from '@weiliang0121/capix-resources';

const memories = new Memories<{ topic?: string }>();
const created = memories.apply([{ action: 'create', value: { content: 'Prefer concise answers', metadata: { topic: 'preference' } } }]);
const first = memories.read(created.changed[0].id)!;
memories.apply([{ action: 'update', memoryId: first.id, value: { content: 'Explain complex questions in detail' }, reason: 'Clarified preference' }], { expected: first.basis });
// first remains the original fixed material; the current item has no metadata.

const memory = memoryResources<{ topic?: string }>();
const resource = new Resource(memories);
const resources = new Resources().register(resource, memory.read).register(resource, memory.apply);
// Share these Offer objects with authors: memory.read.request() / memory.apply.request().
```

`read(id)` returns `{id,basis:{memoriesId,sequence},value}` or undefined. `values()` explicitly enumerates fixed items; `snapshot()` returns `{basis,items}`. `apply(changes, {expected?})` returns `{before,after,changed}`, containing only actual content changes. An omitted expected basis provides no stale-write protection. Optional reason describes the operation; changing only reason does not change content or advance sequence.

`memoryResources<Metadata>()` creates a typed pair of Offers. The read endpoint provides `read(id)` and explicit `snapshot()`; apply provides `apply(changes, expected?)` and `applyFixed({position,changes}, expected?)`. Binding does not capture the collection. `MemoryViewSource<Metadata>` supplies whole or fixed ordered subsets, checks collection sequence, returns fixed `{id,value}`, and uses undefined summaries. Entity updates and View membership remain separate operations.

## Fixed effects and persistence

`applyFixed(request)` and `confirmFixed(request)` use `memories.apply` v2 requests with content contract, memoriesId, accurate `operation: {contextId}`, author `command: {position,changes}` with optional per-change reason, and original expected basis. The entire command and basis are fixed inside the entity write guard. Resource writes derive contextId from the actual calling operation; the application supplies position. The receipt contains `{memoriesId,startSequence,sequence,changes:[{commandIndex,memoryId}]}`. The same operation must match the entire original request, and confirmation returns the original receipt even after later content changes. First fixed no-ops persist confirmation without a content event.

```ts
const request = {
  contract: { key: 'memories.apply', version: 2 } as const,
  contentContract: memories.contentContract,
  memoriesId: memories.id,
  operation: { contextId },
  command: { position: 'remember-answer', changes },
  expected,
};
const receipt = memories.applyFixed(request);
```

`exportState()` and `Memories.restore(state, options?)` use current format v2. Restore is silent, preserves identities and confirmations, and rejects old formats. Optional `contentContract: {key,version,check?}` validates fixed content synchronously; TypeScript metadata types alone do not validate runtime input.

Exported state, commit payloads, events, and reads contain Stable values, not an automatic JSON representation. An adapter that supports undefined, negative zero, or null-prototype records must explicitly encode and decode those distinctions, including fixed requests and receipts. Check encoding and capacity before external writes. Checkpoint authors likewise supply faithful codecs; a display projection cannot replace recovery material.

`persistence.commit` synchronously commits incremental upserts and any fixed confirmation together. If it throws or violates the synchronous return contract, the instance treats the outcome as uncertain: reload from authoritative storage before current reads or further writes. Previously delivered material remains valid, and known exact receipts remain confirmable; an unknown receipt cannot establish that an operation did not execute. Publication failure occurs after installation and does not undo content or confirmation.

## Domain events and display projections

`MemoryEvent<Metadata>` and `MemoryFacts` belong to this package. Each event identifies memoriesId, sequence, time, optional origin, and `{action,memoryId,value,reason?}`. Forwarding uses typed facts; an independent change without origin does not acquire an inferred calling identity.

Default records deliberately project only content and optional reason, omitting unknown metadata. The framework protocol package does not define Memory wire DTOs. Baseline and incremental display values use the same projection. Applications that need topic, source links, or other metadata must define their own projection and encoding. Applications own their persistence adapters and wire DTOs; display projections are not complete entity snapshots or recovery material.

## License

MIT. Copyright (c) 2026 wei.liang. See [LICENSE](LICENSE).
