# 独立记忆实体

`@weiliang0121/capix-memory` 保存有持续身份、可修订的一段总结。它不依赖 Transcript，不要求 topic、消息来源、文件凭据或变更解释；内容是否真实、应提取什么、保留多久及怎样进入 View，由业务策略决定。

`Memories<Metadata = never>` 是唯一写拥有者。单项是固定的 `MemoryItem`，没有第二个可变 Memory 实例：

```ts
type MemoryContent<Metadata = never> = { readonly content: string; readonly metadata?: Metadata };
type MemoryItem<Metadata = never> = { readonly id: string; readonly value: MemoryContent<Metadata> };
type MemoryBasis = { readonly memoriesId: string; readonly sequence: number };
```

集合和单项分别生成 UUID；更新保持单项 ID，不根据正文或主题合并。正文非空，不隐式 trim 或改写。metadata 是业务定义的稳定数据，不授予执行、授权、历史查询或事务能力；画像和业务推进等无需文字总结的对象可以使用自己的实体。

## 读取和写入

```ts
const memories = new Memories<{ topic?: string }>();
const {
  changed: [item],
} = memories.apply([{ action: 'create', value: { content: '用户偏好简短回答', metadata: { topic: '偏好' } } }]);
const first = memories.read(item.id)!; // { id, basis, value }
memories.apply([{ action: 'update', memoryId: item.id, value: { content: '复杂问题可以详细展开' } }], { expected: first.basis });
// first 保留旧正文；这次更新主动去掉了旧 metadata。
```

- `read(id)` 返回当前单项固定材料，未知 ID 返回 undefined；不扫描全集、不提供历史读。
- `values()` 明确取得所有固定项；`snapshot()` 返回固定 `{basis, items}` 全集。
- `apply(changes, {expected?, origin?, observation?})` 返回固定 `{before, after, changed}`，changed 只含实际变化项。
- `expected` 核对集合身份和 sequence，包含空批也核对；省略表示不提供旧依据冲突保护。跨模型等待时应保留原 basis，不能临提交时用新 sequence 替代。
- `reason?: string` 是单次变更说明。只改变 reason 不构成内容变化，但会影响固定请求是否相同。

更新替换完整 value。metadata 的缺失、显式 undefined、-0、普通／null 原型记录均保留差异；对象键插入顺序不单独构成变化。原输入修改不能改写已经形成的项、材料或事件。

写入先进入本实体的重入保护，再固定请求和依据、核验全批、准备固定结果及事件、检查组合容量；可选持久提交成功后安装完整批次，再尝试发布全部实际变化。后项非法、重复更新同一项、缺失目标或 sequence 溢出不能留下前项效果。首条通知出现时整批已安装，不承诺每个中间集合版本都可读取。

按项写入只检查当前批次及涉及的项，已有内容保留认证稳定子图。显式全集读取、导出和 View 目录按实际规模计算，不隐含每次写入导出所有历史。

## 资源与 View

```ts
const memory = memoryResources<{ topic?: string }>();
const resource = new Resource(memories);
const resources = new Resources().register(resource, memory.read).register(resource, memory.apply);
const summarize = new Node({
  deps: { memory: memory.read.request() },
  run(work) {
    if (typeof work.input !== 'string') throw new TypeError('Expected a memory ID');
    return work.resources.memory.read(work.input);
  },
});
```

`memoryResources<Metadata>()` 只创建一组类型一致的 Offer；宿主与作者共享这一组对象，按需登记／申请 read 和 apply。没有新实体或装配生命周期。read 端点提供 `read(id)` 和显式 `snapshot()`；apply 端点提供 `apply(changes, expected?)` 和 `applyFixed({position, changes}, expected?)`。绑定不预先捕获全集。

`MemoryViewSource<Metadata>` 复用现有 ViewSource。默认 summary 为 undefined，不替业务决定主题或摘要；read 返回 `{id,value}`。来源可以覆盖 whole 或固定有序 keys 子集，版本取集合 sequence，稀疏 inspect/read 不枚举其他项。更新 Memory 不自动增加 View 成员，退出 View 不删除 Memory，两个提交不构成事务。

## 内容契约与持久材料

集合可绑定 `contentContract: {key, version, check?}`。默认身份为 `memory.content` v1，只执行内建正文／稳定值约束。自定义 check 同步检查固定的完整 MemoryContent，返回值不替换内容，Promise／thenable 拒绝；check 只依赖固定内容及绑定参数。元信息业务校验变化需更换契约版本。TypeScript 泛型本身不提供运行期字段验证。

`exportState()` 返回当前格式 v2：集合 ID、contentContract、sequence、items 和可选 applies；`Memories.restore(state, options?)` 只接受当前格式及相同内容契约，静默重新核验，不重新 apply、不发布变化、不持久写入。旧格式和无版本材料拒绝，不做自动迁移。

这些是完整 Stable 材料，**不是 JSON 编码承诺**。持久适配器负责自己支持的 metadata codec，并在外部写入前检查编码容量和保真性。JSON 会丢失 undefined、-0 和 null 原型差异；允许这些数据的业务必须明确编码。CP 同理使用作者 codec，不扩大 Frame 值域，也不从当前实体补造过去正文。

`persistence.commit(change)` 是同步增量提交：`{memoriesId, contentContract, expectedSequence, sequence, upserts, fixed?}`。适配器应核对准确实体和旧序号，保持原有项顺序，并将内容和 fixed 凭据一起提交。正常返回 undefined。

## 固定效果确认

固定请求使用 `memories.apply` v2：

```ts
const request = {
  contract: { key: 'memories.apply', version: 2 } as const,
  contentContract: memories.contentContract,
  memoriesId: memories.id,
  operation: { contextId },
  command: { position: 'remember-answer', changes },
  expected,
};
const receipt = memories.applyFixed(request);
// { memoriesId, startSequence, sequence, changes: [{commandIndex, memoryId}] }
```

资源端点从准确调用建立 contextId，业务只提供 command 的 position 和 changes；整个 command 与 expected 在实体同一写入保护内固定。低层实体接收宿主已确定的身份；字符串本身不构成授权。

同操作键先核对完整原请求，包括内容契约、expected 和 reason，再返回原回执；后续实体更新不改变已确认结果。同键不同请求拒绝。首次固定空批／等值更新仍提交凭据，但 sequence 不变、无内容事件；普通空批不需要持久提交。

回执的 changes 只列真实变化位置：create 对应新 ID，update 对应指定 ID，无变化更新无条目。restore 核对位置、唯一性、范围、目标和序号等可证明约束，不用当前正文猜过去是不是 no-op，也不把回执当作完整历史数据库。

## 故障后的边界

持久端口抛错或违反同步返回契约，实体报告 PersistenceError，并标记该实例提交结果不确定：

- 拒绝新写入和当前 read／values／snapshot／export，宿主从权威存储重新载入。
- 已交付固定材料继续有效；准确匹配的旧回执仍可确认。
- 未找到回执时拒绝，不能返回“未执行”；不自动重试、清空或重新生成身份补写。
- 端口可能已经提交，不能把本地尚未安装解释为外部未提交。

变化捕获或观察失败发生在安装之后，保持整个批次和回执，继续尝试其余通知。相同固定操作随后可以确认原效果，不重写、不重发事件。此时实例仍可正常读取，不能与持久提交不确定混为一类。

## 领域事实、记录与展示

MemoryEvent 归 memory：集合 ID、sequence、时间、可选调用来源，以及 `{action,memoryId,value,reason?}`。MemoryFacts 通过类型化事实端口转交；没有来源的独立更新仍无来源，不由全局当前调用补线。

默认 records 适配只投影 content 和可选 reason，MemoryRecord 保留集合／项身份及实际调用关系；`observeMemory` 按准确 memoriesId 关联当前项和记录。baseline 和增量使用同一个正文投影，不夹带未知 metadata，不伪称完整快照。业务需展示或保存其他字段时，使用显式适配。

框架 protocol 不提供 Memory wire。需要 topic、来源跳转或其他 metadata 时，宿主显式定义展示与持久 codec，不能把默认记录投影当作完整实体快照或恢复材料。
