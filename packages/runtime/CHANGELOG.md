# @weiliang0121/capix-runtime

## 0.8.0

### Minor Changes

- e5adad3: Runner 将当次接纳的凭据传入子结果回调。需要父子来源的固定实体操作可在回调内显式转交该凭据。

- e5adad3: 将自动记录观测安装拆为独立包。请从 `@weiliang0121/capix-recording` 导入 `bindRecording` 等记录预设，从 `@weiliang0121/capix-interaction` 导入交互实体。

  Runner 的签名为 `new Runner(scene, resources, options?)`。从旧调用中删除第三位的 `interactions` 或 `undefined` 占位，将原第四位的配置移到第三位。原来只传了场景、资源与交互宿主的调用现在只传场景和资源。低层 CallableBuilder.build 与 CallableBinder.bind 同样将配置移到第三位。保留已通过普通资源供给的渠道。原 `resources.registerInteraction(offer, contract)` 登记改为 `resources.registerBinding(offer, () => interactions.bind(contract))` 按实际申请在构建时绑定。普通两参数运行继续可用。

### Patch Changes

- Updated dependencies [e5adad3]
  - @weiliang0121/capix-platform@0.1.0
  - @weiliang0121/capix-contracts@0.8.0
  - @weiliang0121/capix-checkpoint@0.7.2
  - @weiliang0121/capix-diagnostics@0.7.2
  - @weiliang0121/capix-invocation@0.8.0
  - @weiliang0121/capix-resources@0.8.0
  - @weiliang0121/capix-structure@0.8.0
  - @weiliang0121/capix-changes@0.7.2

## 0.7.2

### Patch Changes

- cdca1c9: 更新包 README 中的安装命令、公开入口与用法说明，并在 npm 包中附带该包的 CHANGELOG.md，供离线查阅版本变化。
- Updated dependencies [cdca1c9]
- Updated dependencies [cdca1c9]
  - @weiliang0121/capix-changes@0.7.1
  - @weiliang0121/capix-checkpoint@0.7.1
  - @weiliang0121/capix-contracts@0.7.1
  - @weiliang0121/capix-diagnostics@0.7.1
  - @weiliang0121/capix-interaction@0.8.1
  - @weiliang0121/capix-invocation@0.7.1
  - @weiliang0121/capix-records@0.7.1
  - @weiliang0121/capix-resources@0.7.1
  - @weiliang0121/capix-structure@0.7.1

## 0.7.1

### Patch Changes

- Update the exact interaction dependency to 0.8.0 so Runtime registrations use the configurable request/reply data budgets and the same Interaction identity as Tool 0.11.0. Other runtime dependencies remain at 0.7.0. Runner behavior and checkpoint formats are unchanged.

## 0.7.0

### Patch Changes

- @weiliang0121/capix-changes@0.7.0
  - @weiliang0121/capix-checkpoint@0.7.0
  - @weiliang0121/capix-contracts@0.7.0
  - @weiliang0121/capix-diagnostics@0.7.0
  - @weiliang0121/capix-interaction@0.7.0
  - @weiliang0121/capix-invocation@0.7.0
  - @weiliang0121/capix-records@0.7.0
  - @weiliang0121/capix-resources@0.7.0
  - @weiliang0121/capix-structure@0.7.0

## 0.6.0

### Patch Changes

- @weiliang0121/capix-changes@0.6.0
  - @weiliang0121/capix-checkpoint@0.6.0
  - @weiliang0121/capix-contracts@0.6.0
  - @weiliang0121/capix-diagnostics@0.6.0
  - @weiliang0121/capix-interaction@0.6.0
  - @weiliang0121/capix-invocation@0.6.0
  - @weiliang0121/capix-records@0.6.0
  - @weiliang0121/capix-resources@0.6.0
  - @weiliang0121/capix-structure@0.6.0

## 0.5.0

### Patch Changes

- @weiliang0121/capix-changes@0.5.0
  - @weiliang0121/capix-checkpoint@0.5.0
  - @weiliang0121/capix-contracts@0.5.0
  - @weiliang0121/capix-diagnostics@0.5.0
  - @weiliang0121/capix-interaction@0.5.0
  - @weiliang0121/capix-invocation@0.5.0
  - @weiliang0121/capix-records@0.5.0
  - @weiliang0121/capix-resources@0.5.0
  - @weiliang0121/capix-structure@0.5.0

## 0.4.0

### Patch Changes

- @weiliang0121/capix-changes@0.4.0
  - @weiliang0121/capix-checkpoint@0.4.0
  - @weiliang0121/capix-contracts@0.4.0
  - @weiliang0121/capix-diagnostics@0.4.0
  - @weiliang0121/capix-interaction@0.4.0
  - @weiliang0121/capix-invocation@0.4.0
  - @weiliang0121/capix-records@0.4.0
  - @weiliang0121/capix-resources@0.4.0
  - @weiliang0121/capix-structure@0.4.0

## 0.3.0

### Patch Changes

- @weiliang0121/capix-changes@0.3.0
  - @weiliang0121/capix-checkpoint@0.3.0
  - @weiliang0121/capix-contracts@0.3.0
  - @weiliang0121/capix-diagnostics@0.3.0
  - @weiliang0121/capix-interaction@0.3.0
  - @weiliang0121/capix-invocation@0.3.0
  - @weiliang0121/capix-records@0.3.0
  - @weiliang0121/capix-resources@0.3.0
  - @weiliang0121/capix-structure@0.3.0

## 0.2.0

### Minor Changes

- 8c25149: Replace transcript/memory observation ports with typed, operation-scoped domain facts. FactType owns a fixed body and matches by exact producer identity. ResourceOperation.facts supplies a synchronous publisher that closes before result reception; new domain entities need no Invocation or checkpoint activity union changes.

  InvocationOrigin now belongs to contracts; consumers must use that public package rather than the removed protocol export. Resources and changes no longer depend on protocol. The default record adapter preserves content records; RecordingOptions.fact allows explicit business projections. Runner exposes source: fact and checkpoint kind: fact metadata in place of the two content-specific checkpoint summaries. Frame v6 and recovery promises are unchanged.

  Reject publication after reentrant access closure and reject widening typed publishers. Existing low-level transcriptObservation/memoryObservation and observer transcript/memory methods must migrate to the new fact interface; there is no legacy alias.

### Patch Changes

- 972d478: Move Message, transcript locators/snapshots/events to transcript; shared InvocationRelationIdentity to contracts; invocation events and stage vocabulary to invocation/events; record data, archive validation and output helpers to records/data. The two data subpaths do not load their Node-specific mechanism or entity implementations. Remove protocol dependencies from domain and runtime packages.

  Narrow protocol to the root TranscriptWireMessage/Snapshot/Event, TranscriptFrame/Update and acceptTranscriptUpdate exports. Remove content, invocation, recording, conversation and observer subpaths. Conversation/Observer business DTOs and endpoint admission now belong to the independent Lab workspace; consumers must update their imports and service-specific contracts explicitly. No old-data migration or compatibility reexports are included.

  Single-frame Transcript admission validates and fixes JSON-compatible values without claiming stream continuity, connection ownership or recovery authority. Domain exports, wire admission, isolated package consumption and framework record invariants are independently tested in CAPiX.

  Accept gaps in resource record sequence numbers because domain facts share the same call-local sequence and are projected separately. Snapshot validation and record-book restoration still require strict order, valid identities, binding phases and operation pairs.

- e48562a: Make Memories an independent summary collection: stable items have UUIDs and `{content, metadata?}` values, with no Transcript ownership, reserved topic, or required sources. Replace mutable Memory instances and the MemoryResource singleton with fixed reads and the typed memoryResources factory. Writes preserve batch atomicity, explicit basis checks and exact fixed-operation confirmation; state and fixed requests now require version 2 with no legacy migration.

  Reject current reads and new writes after an uncertain persistence result, while preserving already acquired material and accurate old receipts. Keep publication failure distinct from commit uncertainty. Metadata uses the Stable data domain; persistence and checkpoint adapters must explicitly encode their supported values.

  Move domain Memory types into the memory package. Default records project only summary content and optional change reason, with matching baseline and incremental semantics. MemoryContent/MemoryEvent protocol exports and the old topic/source wire fields are removed; service-specific wire projections belong to their consumers. View indexing and Frame v6 semantics are unchanged; downstream host policies and codecs require explicit adaptation.

- Updated dependencies [972d478]
- Updated dependencies [e48562a]
- Updated dependencies [8c25149]
  - @weiliang0121/capix-contracts@0.2.0
  - @weiliang0121/capix-invocation@0.2.0
  - @weiliang0121/capix-records@0.2.0
  - @weiliang0121/capix-changes@0.2.0
  - @weiliang0121/capix-resources@0.2.0
  - @weiliang0121/capix-checkpoint@0.2.0
  - @weiliang0121/capix-diagnostics@0.2.0
  - @weiliang0121/capix-interaction@0.2.0
  - @weiliang0121/capix-structure@0.2.0
