# @weiliang0121/capix-model-exchanges

## 0.9.0

### Minor Changes

- e5adad3: 身份、对象检查、同步哈希、字节编码及固定数据比较分别通过平台入口提供。Node 自动选择原生检查。缺少原生检查的宿主可在启动时安装引擎检查能力，或调用 `useAuthorProvidedPlainObjects()`，由作者保证 CAPiX 检查的对象、嵌套内容和相关原型链没有 Proxy 或 JSI `HostObject`。调用该函数不会覆盖 Node 的检查。标准 Hermes 未配置策略时会拒绝需要宿主对象判定的输入。应用可用 `installRandomUUID` 提供 UUID，并在配置完成后动态导入业务模块。

  子结果接纳回调新增仅在该次接纳期间有效的来源凭据。宿主在跨异步等待写入固定实体时，可将凭据传给对应操作。Tool 预设会在自己的固定写入中使用该凭据。Node 上仍支持原有隐式接纳。只声明一个形参的回调可以沿用。将内置函数或会解释额外实参的函数直接用作接纳回调时，请用单参数箭头函数包装。

### Patch Changes

- Updated dependencies [e5adad3]
- Updated dependencies [e5adad3]
- Updated dependencies [e5adad3]
  - @weiliang0121/capix-platform@0.1.0
  - @weiliang0121/capix-contracts@0.8.0
  - @weiliang0121/capix-diagnostics@0.7.2
  - @weiliang0121/capix-model-provider@0.11.1
  - @weiliang0121/capix-resources@0.8.0
  - @weiliang0121/capix-view@0.7.2
  - @weiliang0121/capix-changes@0.7.2

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
