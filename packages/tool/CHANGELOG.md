# @weiliang0121/capix-tool

## 0.12.3

### Patch Changes

- b2c288e: Chat Completions 的 `ModelRequest.trailingMessages` 可以在闭合交换及工具图片附件后追加本次请求的消息。检查、预留和发送计入完整尾部，其他内置协议在发送前拒绝非空尾部。ModelExchanges 与 Tool 固定起点的类型继续只接受前缀消息。
- Updated dependencies [b2c288e]
  - @weiliang0121/capix-model-provider@0.12.0
  - @weiliang0121/capix-model-exchanges@0.9.1

## 0.12.2

### Patch Changes

- e5adad3: 预设在接纳模型与工具的子结果时，将该次接纳凭据传给交换实体的固定写入。目录摘要、预算和材料比较分别使用平台提供的 SHA-256、UTF-8 字节计量和数据比较。

- Updated dependencies [e5adad3]
  - @weiliang0121/capix-platform@0.1.0
  - @weiliang0121/capix-contracts@0.8.0
  - @weiliang0121/capix-checkpoint@0.7.2
  - @weiliang0121/capix-diagnostics@0.7.2
  - @weiliang0121/capix-interaction@0.8.2
  - @weiliang0121/capix-model-exchanges@0.9.0
  - @weiliang0121/capix-model-provider@0.11.1
  - @weiliang0121/capix-resources@0.8.0
  - @weiliang0121/capix-structure@0.8.0

## 0.12.1

### Patch Changes

- Updated dependencies [cbde88e]
  - @weiliang0121/capix-model-provider@0.11.0
  - @weiliang0121/capix-model-exchanges@0.8.1

## 0.12.0

### Minor Changes

- e6a04d0: Handle tool arguments, feedback and recovery across Chat Completions, Responses, Messages and Gemini through the common provider contract. Runs with a wire byte limit and pending feedback or context require a synchronous `reserveWireBytes` inspection method. Built-in providers implement it.

  Tool identifies its optional trailing user context when reserving the next request. Fixed messages keep their measured wire size while the provider reserves growth for the context text and pending feedback.

  Tool catalog precheck policy v5 rejects runs saved under earlier catalog digests, including Chat-only runs. Start a new invocation after upgrading. Tool checkpoint v5 and model node checkpoint v3 retain their formats. Cold confirmation reads the original interaction and feedback; saved capacity decisions also require their effective limits to match.

### Patch Changes

- Updated dependencies [e6a04d0]
- Updated dependencies [e6a04d0]
  - @weiliang0121/capix-model-exchanges@0.8.0
  - @weiliang0121/capix-model-provider@0.10.0

## 0.11.1

### Patch Changes

- cdca1c9: 更新包 README 中的安装命令、公开入口与用法说明，并在 npm 包中附带该包的 CHANGELOG.md，供离线查阅版本变化。
- Updated dependencies [cdca1c9]
  - @weiliang0121/capix-checkpoint@0.7.1
  - @weiliang0121/capix-contracts@0.7.1
  - @weiliang0121/capix-diagnostics@0.7.1
  - @weiliang0121/capix-interaction@0.8.1
  - @weiliang0121/capix-model-exchanges@0.7.2
  - @weiliang0121/capix-model-provider@0.9.1
  - @weiliang0121/capix-resources@0.7.1
  - @weiliang0121/capix-structure@0.7.1

## 0.11.0

### Minor Changes

- Allow request and wire budgets up to 64 MiB and preflight against the smaller host/provider limit. Independently reserve each closed exchange before tool effects; `TOOL_EXCHANGE_LIMIT` supports explicit `capacityPolicy: 'defer'` so oversized batches can be split without executing rejected calls. Defaults, response/feedback budgets and collection limits are unchanged.
- Fix Interaction recovery data limits before reading durable state and reauthenticate saved provider-derived capacity decisions. Keep original host capability receivers, including class private fields. Restoration never resends model requests or repeats tool effects.
- Tool checkpoints advance to v5; earlier versions are rejected without migration or data changes. Completion checkpoints remain v3. ModelExchanges origins and entries remain bounded by 8 MiB, individual exchanges by 2 MiB, and checkpoint logical images by 8 MiB. Larger aggregate requests do not imply arbitrary large raw outputs can be checkpointed.
- Requires model-provider 0.8.0, interaction 0.8.0 and model-exchanges 0.7.1. Other runtime dependencies remain at 0.7.0; consumers using Runtime interactions should upgrade Runtime to 0.7.1 to preserve shared Interaction identity.

## 0.10.0

### Minor Changes

- Add opt-in `capacityPolicy: 'defer'` for request and wire capacity reservations. When pending tool results cannot fit the reserved budget, close only the unexecuted calls with bounded `TOOL_CAPACITY_DEFERRED` feedback. Preserve completed effects and receipts. The default policy remains `fail`; actual capacity, collection, inspection, persistence and cancellation failures are not converted into deferrals.

  Pass a trusted `ToolCapacityBoundary` as the optional second argument of host context `prepare` after feedback closes, allowing the host to choose a new bounded invocation. Skip future-result reservation after the final tool feedback. Closing feedback must fit actual request and collection limits before the decision is saved.

  Migration: Tool checkpoints advance to v4 and bind the capacity policy and saved deferral decisions. Older Tool checkpoints are rejected without modifying their data or replaying effects; start a new invocation after upgrading. Completion checkpoints remain v3. Tool 0.10.0 uses the existing CAPiX 0.7.0 dependencies; the other 17 packages do not require release.

## 0.9.0

### Minor Changes

- Add optional per-member `maxFeedbackBytes` limits for complete tool feedback JSON, including call IDs. Reserve pending feedback by each member's declared capacity, measure fixed invalid/unknown-tool rejections before any member effect, and count request placeholders only once. Enforce the same bound for successful and failed mappings and during cold recovery. Global defaults and request ceilings remain unchanged.

  Add `ToolBudgetError.phase` (`actual` or `reserved`) to distinguish fixed-content measurements from totals that include future capacity reservations. Capacity failures do not roll back effects or automatically retry a failed invocation.

  Migration: the catalog precheck policy advances to version 4 and binds member feedback limits. Older catalog checkpoints are rejected without modifying saved data or resending; start a new invocation after upgrading. Tool and completion checkpoint contracts remain version 3. Tool 0.9.0 continues to use the existing CAPiX 0.7.0 dependencies; no other package release is required.

## 0.8.1

### Patch Changes

- Send host-selected request context as a labeled user-role data message before native exchanges, avoiding synthetic assistant replies without native reasoning on initial reasoning-model requests. Preserve fixed origins, genuine reasoning and tool feedback; count the complete updated label and envelope in context capacity.

  Tool and internal completion checkpoint contracts advance to v3. Reject v2 and earlier checkpoints without rewriting saved requests, selecting new context or resending; begin a new invocation after upgrading. No model-provider or model-exchanges release is required.

## 0.8.0

### Minor Changes

- Add bounded host-selected request context at closed tool-feedback boundaries. Selected text is fixed with the model child, budgeted before dispatch, and reused exactly during recovery without rerunning selection. Native exchanges and the fixed message prefix remain unchanged. Tool and completion checkpoint contracts advance to version 2; older checkpoint contracts are rejected.

  Compatibility: the new request-context API is available in Tool 0.8.0 with CAPiX dependencies at 0.7.0. The two Tool checkpoint contracts change; the checkpoint package format and the other packages' public contracts do not change in this release.

## 0.7.0

### Patch Changes

- Updated dependencies
  - @weiliang0121/capix-model-provider@0.7.0
  - @weiliang0121/capix-model-exchanges@0.7.0
  - @weiliang0121/capix-checkpoint@0.7.0
  - @weiliang0121/capix-contracts@0.7.0
  - @weiliang0121/capix-diagnostics@0.7.0
  - @weiliang0121/capix-interaction@0.7.0
  - @weiliang0121/capix-resources@0.7.0
  - @weiliang0121/capix-structure@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies
  - @weiliang0121/capix-model-provider@0.6.0
  - @weiliang0121/capix-model-exchanges@0.6.0
  - @weiliang0121/capix-checkpoint@0.6.0
  - @weiliang0121/capix-contracts@0.6.0
  - @weiliang0121/capix-diagnostics@0.6.0
  - @weiliang0121/capix-interaction@0.6.0
  - @weiliang0121/capix-resources@0.6.0
  - @weiliang0121/capix-structure@0.6.0

## 0.5.0

### Minor Changes

- Add fixed PNG, JPEG, and WebP image input to user messages and tool results, with canonical base64 validation and bounded request encoding. Portable Chat Completions transport keeps tool feedback textual and projects associated images into a user attachment message after every tool slot is closed.

  Add an explicit, fixed latest-tool-image context window that preserves original exchange images and deterministically reconstructs requests after restore. Reserve portable image attachment metadata before dispatching tools; reject checkpoints using the earlier precheck policy without rewriting saved data.

### Patch Changes

- Updated dependencies
  - @weiliang0121/capix-model-provider@0.5.0
  - @weiliang0121/capix-model-exchanges@0.5.0
  - @weiliang0121/capix-checkpoint@0.5.0
  - @weiliang0121/capix-contracts@0.5.0
  - @weiliang0121/capix-diagnostics@0.5.0
  - @weiliang0121/capix-interaction@0.5.0
  - @weiliang0121/capix-resources@0.5.0
  - @weiliang0121/capix-structure@0.5.0

## 0.4.0

### Minor Changes

- c97dc9d: Return bounded schema-safe field paths and static reason/type diagnostics for rejected tool arguments, with explicit preflight/nonexecution markers. Exclude argument values, arbitrary keys and custom validation messages; retain strict validation without coercion or retry. Advance the catalog precheck policy to version 2: prior Tool checkpoints are rejected without migration, while current feedback is verified on cold recovery.

### Patch Changes

- @weiliang0121/capix-checkpoint@0.4.0
  - @weiliang0121/capix-contracts@0.4.0
  - @weiliang0121/capix-diagnostics@0.4.0
  - @weiliang0121/capix-interaction@0.4.0
  - @weiliang0121/capix-model-exchanges@0.4.0
  - @weiliang0121/capix-model-provider@0.4.0
  - @weiliang0121/capix-resources@0.4.0
  - @weiliang0121/capix-structure@0.4.0

## 0.3.0

### Minor Changes

- d5f0369: Raise the default Tool model-call guard from 8 to 1000 and accept any positive safe integer instead of limiting configuration to 32. Long tool workflows can continue beyond 32 model requests while retaining explicit cancellation, byte budgets, and the author's chosen call limit.

  Export ToolModelCallLimitError with code TOOL_MODEL_CALL_LIMIT, calls, and limit so hosts can report exhaustion separately from provider failures. The guard is checked before the next model invocation; the last permitted response can finish normally, and completed tool effects are retained. Checkpoint recovery preserves the accumulated count and still rejects changed fixed configuration, including the changed default. This does not introduce token quotas or expand context, persistence, or collection capacity.

### Patch Changes

- @weiliang0121/capix-checkpoint@0.3.0
  - @weiliang0121/capix-contracts@0.3.0
  - @weiliang0121/capix-diagnostics@0.3.0
  - @weiliang0121/capix-interaction@0.3.0
  - @weiliang0121/capix-model-exchanges@0.3.0
  - @weiliang0121/capix-model-provider@0.3.0
  - @weiliang0121/capix-resources@0.3.0
  - @weiliang0121/capix-structure@0.3.0

## 0.2.0

### Minor Changes

- ea6d5b3: Add the Tool Group preset with inline typed members, fixed exchange origins, ordinary resource registration, bounded serial model/tool execution, and explicit checkpoint recovery. No per-member factory, special Runner branch, or capture-based resource installer is required.

### Patch Changes

- Updated dependencies [972d478]
- Updated dependencies [ea6d5b3]
- Updated dependencies [8c25149]
  - @weiliang0121/capix-contracts@0.2.0
  - @weiliang0121/capix-model-exchanges@0.2.0
  - @weiliang0121/capix-resources@0.2.0
  - @weiliang0121/capix-checkpoint@0.2.0
  - @weiliang0121/capix-diagnostics@0.2.0
  - @weiliang0121/capix-interaction@0.2.0
  - @weiliang0121/capix-structure@0.2.0
  - @weiliang0121/capix-model-provider@0.2.0
