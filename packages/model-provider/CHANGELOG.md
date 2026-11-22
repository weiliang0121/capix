# @weiliang0121/capix-model-provider

## 0.11.1

### Patch Changes

- e5adad3: 身份、对象检查、同步哈希、字节编码及固定数据比较分别通过平台入口提供。Node 自动选择原生检查。缺少原生检查的宿主可在启动时安装引擎检查能力，或调用 `useAuthorProvidedPlainObjects()`，由作者保证 CAPiX 检查的对象、嵌套内容和相关原型链没有 Proxy 或 JSI `HostObject`。调用该函数不会覆盖 Node 的检查。标准 Hermes 未配置策略时会拒绝需要宿主对象判定的输入。应用可用 `installRandomUUID` 提供 UUID，并在配置完成后动态导入业务模块。

  子结果接纳回调新增仅在该次接纳期间有效的来源凭据。宿主在跨异步等待写入固定实体时，可将凭据传给对应操作。Tool 预设会在自己的固定写入中使用该凭据。Node 上仍支持原有隐式接纳。只声明一个形参的回调可以沿用。将内置函数或会解释额外实参的函数直接用作接纳回调时，请用单参数箭头函数包装。

- Updated dependencies [e5adad3]
  - @weiliang0121/capix-platform@0.1.0

## 0.11.0

### Minor Changes

- cbde88e: Chat Completions JSON and SSE expose the standard nested cached input count when the DeepSeek hit count is absent. Anthropic Messages and OpenAI Responses preserve reported cache writes across JSON, SSE and reply storage as the optional `ModelUsage.promptCacheWriteTokens` field. Partial Messages replies expose the known write count through `modelReplyUsage`. Input and total counts already include these writes.

  Updated readers accept existing v1 replies with omitted write counts. Consumers restoring replies containing the new field need the updated model-provider reader throughout their assembly. Runtime dependencies are unchanged.

## 0.10.0

### Minor Changes

- e6a04d0: Add OpenAI Responses, Anthropic Messages and Gemini generateContent alongside Chat Completions. All four adapters support JSON and SSE, client tool calls, exact request inspection, wire-size reservation and bounded protocol diagnostics. Responses supports explicit history replay and stored-response continuation. Its stream reconciles optional defaults in item and response completion snapshots using the JSON reply rules. Messages preserves signed blocks; Gemini preserves ordered parts and marks locally assigned reply IDs and configured model names when upstream metadata is absent.

  Generic consumers can use `readModelToolArguments` for tool inputs and `modelReplyUsage` for known common counters, including partial Messages measurements. `reply.usage` and completed attempt events continue to require complete counts. Narrow the native format before reading protocol-specific fields. Concrete Chat calls and stored Chat v1 replies keep their existing shape.

  Responses checks echoed storage and predecessor fields on every response snapshot, emits empty logprobs on text replay and checks that tool call IDs fit the function output schema. Messages accepts cumulative usage updates after the stop reason and rejects a decrease in any known counter. A final tool input cut short by `max_tokens` yields an incomplete reply with the preceding complete blocks. Wire reservations account for the provider encoding of a changing context message. Hosts that replace or remove only a trailing user text may declare that shape to reserve its growth separately from the fixed message history.

## 0.9.1

### Patch Changes

- cdca1c9: 更新包 README 中的安装命令、公开入口与用法说明，并在 npm 包中附带该包的 CHANGELOG.md，供离线查阅版本变化。

## 0.9.0

### Minor Changes

- Add opt-in `retry: {maxAttempts, delayMs?, maxDelayMs?}` for generation-only Chat Completions endpoints. Attempts reuse the first encoded request, share the existing total timeout and cancellation, and release readers before retrying. Only internally identified transport failures, interrupted SSE streams and HTTP 408/429/500/502/503/504 can retry. Retry-After is honored within the configured waiting ceiling.
- Add synchronous `ModelControls.attempt` lifecycle events and public `ModelAttemptEvent`, `ModelAttemptFailure` and `ModelRetryOptions` types. Consumer failures preserve their identity and stop notifications and retries; complete replies leave the retry boundary before caller acceptance, persistence or tool execution. Default behavior remains one HTTP attempt. Enabling retries accepts possible repeated inference and billing; it provides no remote-effect idempotency guarantee. Hosts must separate attempt previews and counts and must not interpret missing failed-attempt usage as zero.
- Response-body transport failures now report `NETWORK` rather than `ENVELOPE`; invalid UTF-8, JSON and protocol replies remain `ENVELOPE`. Premature SSE termination reports `ENVELOPE` with attempt phase `stream` and is eligible only when retries are explicitly enabled.
- No runtime dependency is added. The public request/reply and Interaction/Tool contracts are unchanged; this provider can be passed to the existing ModelExchanges 0.7.1 and Tool 0.11.0 APIs. Consumers opt in through their directly installed Provider 0.9.0; unrelated packages do not need a synchronized version bump. Tool counts logical model calls, so hosts imposing HTTP-attempt budgets must additionally account for attempt notifications.

## 0.8.0

### Minor Changes

- Add independent `maxRequestBytes` and `maxWireRequestBytes` to Chat Completions configuration. Defaults remain 2 MiB each; explicit budgets support up to 64 MiB. `inspectRequest` returns fixed operational limits without rejecting a structurally valid over-budget request. `complete` checks the same encoder before HTTP and reports `ProviderRequestLimitError` with metric, bytes and limit.
- Aggregate requests may exceed 2 MiB, while replies, feedback and individual closed exchanges retain their 2 MiB bounds. This is a framework support range, not a vendor capacity claim or process memory limit. Consumers assembling requests through ModelExchanges or Tool should use ModelExchanges 0.7.1 or Tool 0.11.0 respectively; Interaction data budgets must be configured separately. No runtime dependency is added.

## 0.7.0

### Minor Changes

- Add optional synchronous `ModelControls.emitReasoning` to receive validated, nonempty provider reasoning text increments during streaming. Reasoning previews remain separate from answer text and phase-only progress, preserve final reply and exchange content, and use the existing cancellation and consumer-failure contract.

## 0.6.0

### Minor Changes

- Add synchronous ModelControls.progress notifications for validated, nonempty reasoning, text and tool-call stream activity, without exposing reasoning or tool contents. Preserve complete reasoning exchanges and existing text preview, cancellation and consumer failure behavior.

## 0.5.0

### Minor Changes

- Add fixed PNG, JPEG, and WebP image input to user messages and tool results, with canonical base64 validation and bounded request encoding. Portable Chat Completions transport keeps tool feedback textual and projects associated images into a user attachment message after every tool slot is closed.

  Add an explicit, fixed latest-tool-image context window that preserves original exchange images and deterministically reconstructs requests after restore. Reserve portable image attachment metadata before dispatching tools; reject checkpoints using the earlier precheck policy without rewriting saved data.

## 0.4.0

No changes in this release.

## 0.3.0

No changes in this release.

## 0.2.0

No changes in this release.
