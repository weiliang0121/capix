# ModelExchanges

`@capix/model-exchanges` 保存模型的完整回复与每个工具调用的正式反馈。它不保存调用运行状态，不执行工具，不把工具消息写入 Transcript。

```ts
const exchanges = new ModelExchanges({ persistence });
const resources = new Resources().register(new Resource({ exchanges, scope: 'business-loop-id' }), ModelExchangeResource);
```

业务节点申请 `ModelExchangeResource.request()`。模型子结果的 `result.succeeded` 中调用 `intake(reply)`，工具结果接纳中调用 `receive(ref, callId, result)`；资源适配从当前 `activity.reception()` 取得真实父子来源。预检拒绝使用 `complete(ref, callId, result)`，不伪造子调用。宿主可直接使用实体方法并负责提供可信来源。

`scope` 只是宿主固定的业务归属，可以跨多次调用。它不是权限凭据，随机 UUID 也不提供授权；资源供给和宿主隔离决定访问范围。

对象关系：

```text
ModelExchanges
  └─ ModelExchangeEntry（创建顺序不变）
       ├─ 一份 ModelReply：共同输出 + 不重叠的原生补充
       ├─ feedback：按 toolCallId 固定的结果槽位
       └─ operation / receptions：固定接纳凭据
          ↓
ModelExchangeResource          ModelExchangeViewSource
受窗口控制的操作                同一交换作为一个 View 成员
```

- `intake(scope, operation, reply)` 对同一固定操作确认原回复；冲突拒绝。操作键和反馈摘要采用规范化 JSON，不依赖对象属性构造顺序。
- `complete` 新增反馈要求准确集合、scope、交换 ID 和当前 revision；已有槽位的同内容、同来源确认允许较旧引用，不新增 sequence。确认返回当前引用。
- `read` 默认要求准确 revision；资源 `read` 明确允许旧版本引用查询当前槽位，供固定接纳确认。`closed` 要求准确引用、没有重复交换，并且每个工具槽位完整。终止原因是否允许续接仍由模型/业务契约解释。
- `snapshot/restore` 接纳并冻结纯 JSON。恢复先核验集合外壳与条目数组，再逐条捕获、核验并累计集合容量；不将单条目的结构节点预算误用于整个集合。检查版本、创建顺序、变化计数、唯一效果来源、工具槽位与来源关联，不发布变化或调用持久端口。
- 可选持久端口先同步 `commit({ collection, expectedSequence, sequence, previous, entry })`，成功后才安装并发布变化。宿主应原子核验 sequence 和 previous。端口失败或异步返回产生 `PersistenceError`，该实体停止后续写入；宿主重新载入决定未知提交的实际结果。不会自动重试。变化发布失败保留已经成立的事实。
- 默认预算 `defaultModelExchangeLimits` 为 10,000 个交换、累计 64 MiB 的交换 JSON；可显式调整，`maximumModelExchangeLimits` 限定最大 100,000 个、128 MiB。每个交换最大 `maximumModelExchangeEntryBytes`（8 MiB），Provider 单回复/单反馈自己的限制仍适用。超限在持久提交前拒绝，不将实体标为持久故障；已有事实仍可读取和确认。没有自动淘汰：过期与保留策略归宿主。
- ViewSource 可以固定某个 scope 或全体；版本覆盖成员和反馈变化，完整目录按创建顺序返回，`inspect/read` 只访问请求的 keys。旧快照保持原值，版本变化后读取拒绝。视图策略可退出整个交换，不能留下孤立 tool 消息。

新服务的 SQLite `store.exchanges` 提供 `load(collectionId)`、`initialize(empty, metadata)`、`commit(change)` 与分页 `list()`。先初始化对话内容，再以固定元数据初始化空交换集合；载入返回 `{ state, metadata }`，实体通过 `ModelExchanges.restore(state, { persistence: store.exchanges, limits })` 接回。Schema v4 最初新增交换表，v5 将其扩展为独立多集合；旧 v4 集合迁为未锚定只读，当前 v6 延续此接口。实体提交不与 Invocation CP 或其他实体构成事务。

SQLite 的初始化、写入与载入统一采用实体公开的最大容量，支持显式高于默认预算的集合；实体自身仍在提交前执行宿主选定的预算。预算不写进快照，宿主恢复时应再次传入同一配置：`ModelExchanges.restore(state, { persistence: store.exchanges, limits })`。用更低预算恢复过大的快照会明确拒绝，不截断或淘汰原记录。

SQLite 按准确 ID 载入并核验一个完整集合，启动和分页目录查询不加载全部旧交换正文。CLI/Web 的可选工具宿主已为每次回答分配独立集合，ToolExchangeUse 在本次 run/resume 退出时关闭并释放载入实体；独立交互继续按自身生命周期保存反馈。集合容量与两种回答模式的联合归档入口门槛分别检查，目前没有自动退休归档。退出 View 或关闭句柄均不删除事实，不能据此删除尚被恢复或续接引用的记录。宿主范围见 [原生工具宿主设计](../../docs/native-tool-host-integration.md)。
