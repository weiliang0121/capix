# ModelExchanges

`@weiliang0121/capix-model-exchanges` 保存一次模型对话的固定起点，以及从该起点累积的完整回复和工具反馈。起点包括初始消息、请求选项和模型可见的工具目录；Node、执行函数及资源权限仍留在结构与资源中。

```ts
const exchanges = new ModelExchanges({ persistence });
const resources = new Resources().register(new Resource(exchanges), ModelExchangeResource);

// ID 由宿主或业务固定。需要恢复时，先在 prepared CP 保存 ID，再 begin。
const origin = exchanges.begin('prepared-origin-id', {
  request: {
    messages: [{ role: 'user', content: '查询天气' }],
    maxTokens: 1024,
  },
  catalog: {
    tools: [{ name: 'weather', description: '查询天气', parameters: { type: 'object' } }],
    digest: 'weather-catalog-v1',
    policyVersion: 'weather-policy-v1',
  },
});

// 模型子调用只传引用；发送资源在自己的访问窗口内展开请求。
const input = { origin, exchanges: [] };
const request = exchanges.request(input);
// request 包含固定初始消息、选项、工具目录及所选交换前缀。
```

不需要为了提供初始材料，在父结构上额外安装一次 capture。一个集合可容纳多个独立起点，资源只需普通登记。`origin` 引用是内容身份，不是授权凭据；登记整个实体会开放该资源端点的集合范围，宿主隔离与资源供给仍负责访问范围。

对象关系：

```text
ModelExchanges
  ├─ origin A：初始请求 + 模型可见目录（固定）
  │    ├─ exchange 1：完整模型回复 + 按 toolCallId 固定的反馈
  │    └─ exchange 2：完整模型回复 + 按 toolCallId 固定的反馈
  └─ origin B：另一份固定起点及其交换
         ↓
ModelExchangeResource             ModelExchangeViewSource
本次窗口内的读写和请求重建          交换作为 View 成员，可限定一个 origin
```

## 起点与请求

- `begin(id, basis)` 固定整个纯数据输入。同 ID、同内容只确认，不新增提交或变化；不同内容明确拒绝。没有回复的空起点也进入持久序列。`origin(ref)` 核对集合、ID 和完整起点摘要后返回固定内容。
- `basis.request` 支持 ModelRequest 的消息与选项，不接受 `tools` 或 `exchanges`；目录统一放在 `basis.catalog`，历史由实体组织。选项保持原样，不隐含默认覆盖。空 `catalog.tools` 表达无工具模型调用，重建请求省略 `tools` 字段。
- `catalog.digest` 和 `policyVersion` 由执行结构提供兼容依据；实体另外计算 `origin.digest`，覆盖完整初始请求和目录。目录只包含模型可见的协议数据，不能放入 Node、映射回调或端点。恢复时，执行方仍须核对当前结构与保存目录是否兼容，实体不会从函数推导执行语义。
- `closed(origin, refs)` 要求引用属于同一起点、revision 准确、顺序为该起点最前面的 K 个交换，且每个工具反馈槽完整。允许选择较短的历史前缀以重建原请求；不能重排、跳过中间项或重复同一交换。它只确认反馈完整性，不判断当前业务能否继续。
- `request({ origin, exchanges })` 组合起点与明确前缀，执行 Provider 的完整请求校验，包括终止原因的续接资格和整体请求限额。它不发送请求，也不授权重试；查询旧前缀不等于恢复资格成立。实体只保存接纳顺序，模型子输入与实际发送历史的因果一致性仍由调用和宿主核验。

## 接纳与反馈

节点申请 `ModelExchangeResource.request()`。接纳模型子结果时调用 `work.resources.exchanges.intake(origin, reply)`，接纳工具子结果时调用 `receive(origin, ref, callId, result)`。资源适配从当前 `activity.reception()` 取得准确父子来源；预检拒绝使用 `complete(origin, ref, callId, result)`，不伪造子调用。直接调用实体方法的宿主负责提供可信来源。

- 实体 `intake(origin, operation, reply)` 对同一固定操作确认原回复，来源或内容冲突拒绝。工具的原始名称、调用 ID 和参数保存在完整回复中，不因反馈写入而丢失。
- 实体 `complete(origin, ref, callId, result, operation?)` 新增反馈要求准确集合、起点、交换 ID 和当前 revision。已有槽位同内容、同来源的确认允许较旧引用，返回当前引用，不新增 sequence。
- `read(origin, ref)` 默认要求准确 revision；需要查询最新槽位以确认固定效果时，显式传 `false`。`values(origin?)` 返回创建顺序中的交换；不传起点则读取全体。
- 接纳回执保留准确引用、来源及反馈摘要。它们是确认依据，不构成工具效果、接纳与 CP 的统一事务。

## 持久化与恢复

当前快照是 **formatVersion 2**，包含 `origins`、`entries` 和共同变化序列。旧格式、旧 `scope` 供给形状明确拒绝，不提供迁移或同义兼容 API。

持久端口同步接收两种提交：

```ts
commit(change) {
  // 在同一事务中比较 collection 和 expectedSequence。
  if (change.kind === 'origin') {
    // 首次保存 change.origin。
  } else {
    // 核对 change.previous，再保存 change.entry。
  }
  // 同事务推进 sequence；成功返回后实体才安装并发布变化。
}
```

端口失败或异步返回产生 `PersistenceError`，实体停止后续写入；宿主重新载入确认未知提交的实际结果，不自动重试。变化发布失败保留已经成立的事实。同内容确认不重复提交。

`ModelExchanges.restore(state, { persistence, limits })` 核验起点摘要、交换归属、创建顺序、变化计数、唯一效果来源、槽位和来源关联，再安装固定内容；不发布变化或调用持久端口。丢失起点时不能仅凭交换补造初始消息或目录。持久适配应保真保存已接纳数据，例如 `-0` 经普通 JSON 往返变成 `0` 会导致摘要拒绝，不能当作同一份依据。

默认预算为 10,000 个起点、10,000 个交换、累计 64 MiB 的起点与交换 JSON 正文；最大分别为 100,000、100,000 和 128 MiB。单起点、单交换均至多 8 MiB；Provider 对初始及重建请求另有限额（当前 2 MiB），不因集合容量较大而放宽。预算不等于堆内存上界。

超限在持久提交前拒绝，不将实体标为持久故障；已有事实仍可读取和确认。预算不写入快照，恢复应传入相同配置；更低预算不足时拒绝，不截断。没有自动淘汰、删除或跨实体事务；宿主负责被恢复依据引用的内容保留。

## View 与验证范围

`new ModelExchangeViewSource(exchanges, origin?)` 可读取全体或一个准确起点的交换。起点本身不是自动加入 View 的材料，内容选择仍由策略决定。版本覆盖起点建立、成员与反馈变化；`inspect/read` 只读取请求的 keys，旧快照保持原值，来源版本变化后读取拒绝。退出视图不删除事实。

包内测试覆盖起点固定、请求重建、预算、持久未知、格式拒绝和 View；Runtime 包的集成测试使用真实 Scene/Node/Group、资源、Interaction 与 CP，验证普通登记和新 Runner 恢复，核对缺失或变化的依据不会触发重发。[Tool](../tool/README.md) 提供公开 Group 预设；不把离线恢复验证当作外部工具效果的恢复承诺。
