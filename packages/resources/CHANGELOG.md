# @weiliang0121/capix-resources

## 0.8.0

### Minor Changes

- e5adad3: 身份、对象检查、同步哈希、字节编码及固定数据比较分别通过平台入口提供。Node 自动选择原生检查。缺少原生检查的宿主可在启动时安装引擎检查能力，或调用 `useAuthorProvidedPlainObjects()`，由作者保证 CAPiX 检查的对象、嵌套内容和相关原型链没有 Proxy 或 JSI `HostObject`。调用该函数不会覆盖 Node 的检查。标准 Hermes 未配置策略时会拒绝需要宿主对象判定的输入。应用可用 `installRandomUUID` 提供 UUID，并在配置完成后动态导入业务模块。

  子结果接纳回调新增仅在该次接纳期间有效的来源凭据。宿主在跨异步等待写入固定实体时，可将凭据传给对应操作。Tool 预设会在自己的固定写入中使用该凭据。Node 上仍支持原有隐式接纳。只声明一个形参的回调可以沿用。将内置函数或会解释额外实参的函数直接用作接纳回调时，请用单参数箭头函数包装。

### Patch Changes

- e5adad3: 独立资源包通过宿主的 Web Crypto 支持资源声明、供给和操作身份。子调用接纳按平台选择异步来源跟踪，Node 保留原有的并发和嵌套语义。默认条件可以接纳结果并等待收尾。固定实体操作可使用回调签发的显式凭据核对接纳身份。
- Updated dependencies [e5adad3]
- Updated dependencies [e5adad3]
  - @weiliang0121/capix-platform@0.1.0
  - @weiliang0121/capix-contracts@0.8.0
  - @weiliang0121/capix-changes@0.7.2

## 0.7.1

### Patch Changes

- cdca1c9: 更新包 README 中的安装命令、公开入口与用法说明，并在 npm 包中附带该包的 CHANGELOG.md，供离线查阅版本变化。
- Updated dependencies [cdca1c9]
  - @weiliang0121/capix-changes@0.7.1
  - @weiliang0121/capix-contracts@0.7.1

## 0.7.0

### Patch Changes

- @weiliang0121/capix-changes@0.7.0
  - @weiliang0121/capix-contracts@0.7.0

## 0.6.0

### Patch Changes

- @weiliang0121/capix-changes@0.6.0
  - @weiliang0121/capix-contracts@0.6.0

## 0.5.0

### Patch Changes

- @weiliang0121/capix-changes@0.5.0
  - @weiliang0121/capix-contracts@0.5.0

## 0.4.0

### Patch Changes

- @weiliang0121/capix-changes@0.4.0
  - @weiliang0121/capix-contracts@0.4.0

## 0.3.0

### Patch Changes

- @weiliang0121/capix-changes@0.3.0
  - @weiliang0121/capix-contracts@0.3.0

## 0.2.0

### Minor Changes

- 8c25149: Replace transcript/memory observation ports with typed, operation-scoped domain facts. FactType owns a fixed body and matches by exact producer identity. ResourceOperation.facts supplies a synchronous publisher that closes before result reception; new domain entities need no Invocation or checkpoint activity union changes.

  InvocationOrigin now belongs to contracts; consumers must use that public package rather than the removed protocol export. Resources and changes no longer depend on protocol. The default record adapter preserves content records; RecordingOptions.fact allows explicit business projections. Runner exposes source: fact and checkpoint kind: fact metadata in place of the two content-specific checkpoint summaries. Frame v6 and recovery promises are unchanged.

  Reject publication after reentrant access closure and reject widening typed publishers. Existing low-level transcriptObservation/memoryObservation and observer transcript/memory methods must migrate to the new fact interface; there is no legacy alias.

### Patch Changes

- Updated dependencies [972d478]
- Updated dependencies [8c25149]
  - @weiliang0121/capix-contracts@0.2.0
  - @weiliang0121/capix-changes@0.2.0
