# @weiliang0121/capix-model-provider

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
