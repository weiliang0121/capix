# @weiliang0121/capix-model-provider

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
