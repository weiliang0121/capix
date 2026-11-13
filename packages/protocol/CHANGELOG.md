# @weiliang0121/capix-protocol

## 0.2.0

### Minor Changes

- 972d478: Move Message, transcript locators/snapshots/events to transcript; shared InvocationRelationIdentity to contracts; invocation events and stage vocabulary to invocation/events; record data, archive validation and output helpers to records/data. The two data subpaths do not load their Node-specific mechanism or entity implementations. Remove protocol dependencies from domain and runtime packages.

  Narrow protocol to the root TranscriptWireMessage/Snapshot/Event, TranscriptFrame/Update and acceptTranscriptUpdate exports. Remove content, invocation, recording, conversation and observer subpaths. Conversation/Observer business DTOs and endpoint admission now belong to the independent Lab workspace; consumers must update their imports and service-specific contracts explicitly. No old-data migration or compatibility reexports are included.

  Single-frame Transcript admission validates and fixes JSON-compatible values without claiming stream continuity, connection ownership or recovery authority. Domain exports, wire admission, isolated package consumption and framework record invariants are independently tested in CAPiX.

  Accept gaps in resource record sequence numbers because domain facts share the same call-local sequence and are projected separately. Snapshot validation and record-book restoration still require strict order, valid identities, binding phases and operation pairs.

- e48562a: Make Memories an independent summary collection: stable items have UUIDs and `{content, metadata?}` values, with no Transcript ownership, reserved topic, or required sources. Replace mutable Memory instances and the MemoryResource singleton with fixed reads and the typed memoryResources factory. Writes preserve batch atomicity, explicit basis checks and exact fixed-operation confirmation; state and fixed requests now require version 2 with no legacy migration.

  Reject current reads and new writes after an uncertain persistence result, while preserving already acquired material and accurate old receipts. Keep publication failure distinct from commit uncertainty. Metadata uses the Stable data domain; persistence and checkpoint adapters must explicitly encode their supported values.

  Move domain Memory types into the memory package. Default records project only summary content and optional change reason, with matching baseline and incremental semantics. MemoryContent/MemoryEvent protocol exports and the old topic/source wire fields are removed; service-specific wire projections belong to their consumers. View indexing and Frame v6 semantics are unchanged; downstream host policies and codecs require explicit adaptation.

### Patch Changes

- 8c25149: Replace transcript/memory observation ports with typed, operation-scoped domain facts. FactType owns a fixed body and matches by exact producer identity. ResourceOperation.facts supplies a synchronous publisher that closes before result reception; new domain entities need no Invocation or checkpoint activity union changes.

  InvocationOrigin now belongs to contracts; consumers must use that public package rather than the removed protocol export. Resources and changes no longer depend on protocol. The default record adapter preserves content records; RecordingOptions.fact allows explicit business projections. Runner exposes source: fact and checkpoint kind: fact metadata in place of the two content-specific checkpoint summaries. Frame v6 and recovery promises are unchanged.

  Reject publication after reentrant access closure and reject widening typed publishers. Existing low-level transcriptObservation/memoryObservation and observer transcript/memory methods must migrate to the new fact interface; there is no legacy alias.

- Updated dependencies [972d478]
- Updated dependencies [8c25149]
  - @weiliang0121/capix-contracts@0.2.0
