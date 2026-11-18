# @weiliang0121/capix-model-provider

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
