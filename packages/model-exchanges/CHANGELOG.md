# @weiliang0121/capix-model-exchanges

## 0.8.1

### Patch Changes

- Updated dependencies [cbde88e]
  - @weiliang0121/capix-model-provider@0.11.0

## 0.8.0

### Minor Changes

- e6a04d0: Admit and restore Responses, Messages and Gemini replies with the matching model-provider, retaining native continuation material and tool feedback slots in v2 snapshots. Add a read-only feedback preview that applies the same image retention rules as the next request and accounts for retained images that pending feedback could displace.

### Patch Changes

- Updated dependencies [e6a04d0]
  - @weiliang0121/capix-model-provider@0.10.0

## 0.7.2

### Patch Changes

- cdca1c9: 更新包 README 中的安装命令、公开入口与用法说明，并在 npm 包中附带该包的 CHANGELOG.md，供离线查阅版本变化。
- Updated dependencies [cdca1c9]
  - @weiliang0121/capix-changes@0.7.1
  - @weiliang0121/capix-contracts@0.7.1
  - @weiliang0121/capix-diagnostics@0.7.1
  - @weiliang0121/capix-model-provider@0.9.1
  - @weiliang0121/capix-resources@0.7.1
  - @weiliang0121/capix-view@0.7.1

## 0.7.1

### Patch Changes

- Update the exact model-provider dependency to 0.8.0. Accumulated histories above 2 MiB can be reconstructed within its aggregate request support range; actual sending still enforces host/provider budgets. Origin and entry storage ceilings remain 8 MiB, and individual closed exchanges remain 2 MiB. Other runtime dependencies remain at 0.7.0.

## 0.7.0

### Patch Changes

- Updated dependencies
  - @weiliang0121/capix-model-provider@0.7.0
  - @weiliang0121/capix-changes@0.7.0
  - @weiliang0121/capix-contracts@0.7.0
  - @weiliang0121/capix-diagnostics@0.7.0
  - @weiliang0121/capix-resources@0.7.0
  - @weiliang0121/capix-view@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies
  - @weiliang0121/capix-model-provider@0.6.0
  - @weiliang0121/capix-changes@0.6.0
  - @weiliang0121/capix-contracts@0.6.0
  - @weiliang0121/capix-diagnostics@0.6.0
  - @weiliang0121/capix-resources@0.6.0
  - @weiliang0121/capix-view@0.6.0

## 0.5.0

### Minor Changes

- Add fixed PNG, JPEG, and WebP image input to user messages and tool results, with canonical base64 validation and bounded request encoding. Portable Chat Completions transport keeps tool feedback textual and projects associated images into a user attachment message after every tool slot is closed.

  Add an explicit, fixed latest-tool-image context window that preserves original exchange images and deterministically reconstructs requests after restore. Reserve portable image attachment metadata before dispatching tools; reject checkpoints using the earlier precheck policy without rewriting saved data.

### Patch Changes

- Updated dependencies
  - @weiliang0121/capix-model-provider@0.5.0
  - @weiliang0121/capix-changes@0.5.0
  - @weiliang0121/capix-contracts@0.5.0
  - @weiliang0121/capix-diagnostics@0.5.0
  - @weiliang0121/capix-resources@0.5.0
  - @weiliang0121/capix-view@0.5.0

## 0.4.0

### Patch Changes

- @weiliang0121/capix-changes@0.4.0
  - @weiliang0121/capix-contracts@0.4.0
  - @weiliang0121/capix-diagnostics@0.4.0
  - @weiliang0121/capix-model-provider@0.4.0
  - @weiliang0121/capix-resources@0.4.0
  - @weiliang0121/capix-view@0.4.0

## 0.3.0

### Patch Changes

- @weiliang0121/capix-changes@0.3.0
  - @weiliang0121/capix-contracts@0.3.0
  - @weiliang0121/capix-diagnostics@0.3.0
  - @weiliang0121/capix-model-provider@0.3.0
  - @weiliang0121/capix-resources@0.3.0
  - @weiliang0121/capix-view@0.3.0

## 0.2.0

### Minor Changes

- ea6d5b3: Store immutable initial request data and model-visible tool catalogs alongside their accumulated exchanges. Resources now register ModelExchanges directly and use explicit origin references to reconstruct requests. Snapshot v2 and the discriminated persistence commits replace the old scope-only format; existing hosts must adapt their resource and persistence contracts. Old snapshots are rejected without migration.

### Patch Changes

- Updated dependencies [972d478]
- Updated dependencies [7ecd487]
- Updated dependencies [8c25149]
  - @weiliang0121/capix-contracts@0.2.0
  - @weiliang0121/capix-view@0.2.0
  - @weiliang0121/capix-changes@0.2.0
  - @weiliang0121/capix-resources@0.2.0
  - @weiliang0121/capix-diagnostics@0.2.0
  - @weiliang0121/capix-model-provider@0.2.0
