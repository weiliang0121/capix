# Memory 收敛设计：领域预设与共同能力

状态：2026-11-11 领域边界已收敛，迁移接缝已审查，尚未实施。基于当前 `packages/memory` 源码、包内回归及 [Lab 能力验证](../../capix-lab/examples/entity-capabilities-study/README.md)。本文不改变现行 API；类型和方法写法用于收敛职责，不是已实施承诺。

## 1. 先确定 Memory 的边界

用户已确定的含义是：**有持续身份、可以修订的一段压缩总结。** 内核保存总结，不负责验证压缩率、模型理解是否正确或原文是否充分。画像、结构化知识和业务推进等特化需求由业务实体组合共同能力实现；有明确复用需要时再评估专用预设。

共同固定读取、资源访问、ViewSource、变化转交，服务于所有合适的实体。Memory 是其中一个专用实现，不是通用实体基类。前轮 `StudyMemories<Value>` 用完全泛型正文证明了能力组合可行；不能由此推出正式 Memory 应接收所有业务对象。

已确定的内容边界及候选类型形状：

```ts
type MemoryContent<Metadata = never> = {
  readonly content: string; // 非空总结正文，不做隐式 trim 或模型改写
  readonly metadata?: Metadata; // 作者显式定义；受稳定值域和容量限制
};

type MemoryItem<Metadata = never> = {
  readonly id: string; // 实体生成的 UUID；更新内容不改变身份
  readonly value: MemoryContent<Metadata>;
};
```

保留 `content` 命名，不为了重构换一套同义正文术语。不再预留 `topic`；业务需要主题、标签、来源或适用条件时，自己定义 metadata。`Metadata` 只表示扩展数据，不赋予它执行、权限、事务或恢复语义。需要运行期字段校验的预设应提供同步、纯的内容校验；持久内容的业务契约版本也必须覆盖这份校验，不能仅靠 TypeScript 泛型宣称旧材料兼容。候选先按集合绑定一份内容契约，需要多个形状时由该契约明确表达，不引入逐项动态 schema 注册。

Memory 的 ID 标识这一项，不标识正文内容；两项内容完全相同也可以有不同 ID。`value` 不必再放一份 ID。集合身份、单项身份和内容版本分别表达，不为了统一外观给全部其他实体追加 UUID；例如当前消息以 Transcript 身份和消息 index 定位，不能把它误认为裸 value 的全局唯一性。

业务需要没有文字正文的结构化对象时，应定义自己的实体，复用共同能力，不必把它序列化成一条假记忆。这同时适用于权威业务状态与非权威的结构化理解，不将两者混为一类。

## 2. 分类、来源和推进各自归位

| 维度       | Memory 自己保证什么                      | 由谁决定                                                                    |
| ---------- | ---------------------------------------- | --------------------------------------------------------------------------- |
| 内容       | 正文和元信息成为固定值，更新不改写旧材料 | 内容含义、真实性与采纳规则由业务负责                                        |
| topic      | 无保留字段，只固定业务提供的元信息       | 自动提取、分类表、允许哪些 topic 由策略 Node 或预设负责                     |
| 长期／短期 | 不内建两个实体 kind                      | 指保留多久时归保留策略；指给模型看什么时归 View；指内容有效期时是业务元信息 |
| 来源       | 不要求 Transcript、消息索引或特定凭据    | 来源字段、解析及校验由具体预设定义，可引用消息、文档、业务记录或没有来源    |
| 业务推进   | 可以记录“对当前进展的理解”               | 工作流阶段、效果确认、认领与提交由业务推进实体和操作保证                    |
| 观测       | 发布确实成立的变化                       | 解释、展示、领域事实与调用的准确关联由适配及装配负责                        |

`topic` 的自动产生发生在策略节点里，不在实体的同步写入钩子里调用模型。用户提供 topic 模型／分类表时，同样由节点或预设决定如何使用；记忆实体不承诺分类准确或自动纠错。

现有以下约束应退出最小 Memory：

- 构造函数必须持有一个 `Transcript`。
- `sourceIndexes` 必须非空、每次变化的来源必须被结果继续包含。
- `sourceResults` 只允许 `file-created`，强制关联 assistant 消息并校验文件凭据格式。
- 每次写入必须提供自然语言变化解释。

这些规则有些仍适合当前对话装配。应先留在那个装配的明确预设中，不能仅将字段改 optional、把原检查藏在实体内部，也不必立刻把它们升级成公共预设包。

若业务选择保留来源，必须明确其含义：内容里的来源值是业务提供的依据；它不自动证明模型实际读过，也不证明外部对象现在仍存在。来源变更不自动修改 View 成员。

## 3. 一个拥有者，单项以固定值交付

现有 `Memory` 是可构造的活对象，`Memories` 才拥有批次、序号、持久化和固定凭据。`Memory` 没有公开写方法，更新由包私有函数 `updateMemory` 完成；没有独立写入或持久生命周期。

建议正式写边界仍只有 `Memories`。单项保留 UUID 和固定正文，但不再要求作者持有可变的 `Memory` 类实例：

```ts
type MemoryBasis = {
  readonly memoriesId: string;
  readonly sequence: number; // 集合内容变化序号，不是单项 revision
};

type MemoryRead<Metadata = never> = Stable<MemoryItem<Metadata> & { readonly basis: MemoryBasis }>;

const memories = new Memories();
const applied = memories.apply([{ action: 'create', value: { content: '用户偏好简洁回答' } }]);
const id = applied.changed[0].id;
const first = memories.read(id);

memories.apply([{ action: 'update', memoryId: id, value: { content: '用户偏好简洁回答，复杂问题可以展开' } }], { expected: first.basis });

// first 仍然是之前的材料；再次 read 才取得当前材料。
```

读取形状是 `{id, basis, value}`，单项 ID 保留在外层；其中 `{basis, value}` 满足共同固定材料的切面，不需要第二层 `value` 或重复的 `memoryId`。按单项传递材料时仍须保留外层 ID，basis 本身不能定位单项。这里 `expected` 核验的是 basis 中的集合身份和 sequence；单项身份由 mutation 明确指定。需要对整个集合做决策时另有完整 snapshot，不能用单项 read 冒充全集。

`read(id)` 是普通当前读取，不是 `resolve(oldBasis)`。没有历史正文库时，单独的 ID／sequence 不能恢复旧正文。先不新增单项 revision、删除、归档、统一状态枚举或自动历史保留。

资源端点只暴露准确申请的方法。构造结构时不捕获全量内容；按需的 `read` 与显式完整 `snapshot` 分开，现有绑定期固定材料可以作为一种供给方式，不能成为每次使用记忆的前提。

## 4. 内容更新与固定确认不能被简化掉

候选 mutation：

```ts
type MemoryMutation<Metadata = never> = { readonly action: 'create'; readonly value: MemoryContent<Metadata>; readonly reason?: string } | { readonly action: 'update'; readonly memoryId: string; readonly value: MemoryContent<Metadata>; readonly reason?: string };
```

`reason` 是这次操作的可选说明，不是需要永久带入正文的来源，也不由内核根据文本差异生成。它参与固定操作的请求一致性判断；仅改 reason、不改正文不会产生新的内容变化。

建议保留如下能力，不建立两套内部写逻辑：

| 能力                          | 意义                                                 |
| ----------------------------- | ---------------------------------------------------- |
| `read`／显式 `snapshot`       | 固定单项／全集材料与准确当前依据                     |
| `apply(changes, {expected?})` | 普通整批写入，返回固定的实际变化结果                 |
| `applyFixed(request)`         | 相同准确操作只成立一次；内容效果与凭据在同一实体提交 |
| `confirmFixed(request)`       | 确认已有操作，不把当前内容相等当作已执行             |
| `exportState`／`restore`      | 当前格式的持久载入，不重放业务写入                   |
| `MemoryViewSource`            | 可选目录、范围与版本读取适配                         |

`apply` 返回的候选结果是 `{before, after, changed:[{id,value}]}`；`changed` 仅包含真实内容变化，都是固定值，不泄露活对象。普通结果不是固定操作回执。

`expected` 可选，但省略必须明确表示不检查调用方的旧集合依据，不能宣称仍能防止覆盖他人的新内容。跨模型等待的“读—算—写”应携带读时 basis，提交前重新读取 sequence 不能替代它。依据核验归实体写入保护内，资源不独立完成一半核验再调用实体。

### 固定回执的关键区别

保持当前操作身份规则：资源从真实调用的 `activity.origin.contextId` 建立操作键，业务只补 `position`；不因为重构切换成不同的父子接纳身份。实体低层可以接受宿主已确定的请求身份，但 ID 字符串不是授权。

相同操作键必须比较完整固定请求，包括内容契约、变更、可选说明及原 expected 依据。同键不同请求拒绝；不是最后正文一样就算同一操作。

| 情况                   | 内容 sequence    | 持久提交           | 发布内容变化 |
| ---------------------- | ---------------- | ------------------ | ------------ |
| 普通空批／等值更新     | 不变             | 不需要             | 无           |
| 首次固定空批／等值更新 | 不变             | 保存固定凭据       | 无           |
| 首次固定有效变更       | 按实际变化项递增 | 内容与凭据一起提交 | 有           |
| 再次确认相同固定操作   | 保留原回执       | 不重写             | 不重发       |

先查准确固定凭据，再判断新写入的当前版本；已确认操作使用原依据，不因后续更新变成失败。这里“查不到”仅在可信、未处于提交不确定的实例上允许表达未确认。

当前 receipt 只有实际变更 IDs，丢掉了与请求位置的直接对应。候选可增加稀疏对应 `{commandIndex,memoryId}`，仅覆盖实际变化项：create 必须对应一个新 ID，update 必须对应目标 ID，无变化 update 没有条目。由此核对序号增量、重复项、范围和请求对应关系，不需要保存第二份正文或凭据里的完整历史快照。

这能检查可直接证明不可能的回执，不能凭当前正文复原历史等值判断，更不能提供任意篡改检测。后续合法更新可能早已改变正文。

## 5. 写入时序与容量

```text
进入本实体写入保护
  → 固定调用方请求／依据／操作身份，拒绝访问器与不支持的数据
  → 固定操作已有记录：核对完整请求，返回原回执
  → 新操作：核对当前集合依据、全部目标、重复更新和内容契约
  → 判定内容变化；准备 ID、返回值、变化事实及固定回执
  → 所有需要成立的完整数据通过固定与容量检查
  → 可选 persistence.commit（一次，含增量内容与固定凭据）
  → 安装整批内容、最终 sequence 与回执
  → 尝试发布全部实际变化，再报告发布故障
退出本实体写入保护
```

这保持现有整批语义：后项非法不能留下前项效果；同一批不允许两次更新同一项；发布第一条变化时整批已经安装。各项事件的 sequence 表示变化顺序，不承诺可读到每个中间集合版本。

新正文在成立时经过 `stableValue`；旧认证正文可以复用。准备时要检查完整返回／事件的组合容量，不能先提交后因包裹一层固定材料而失败。事件保存准确新正文与可选说明即可，不强制像实验一样携带完整 previous 正文；需要差异或旧材料的预设自己声明。

只处理当前批次和涉及的项：不因写一条记忆而导出全集。全集 snapshot、完整导出和 View 全量目录仍按实际读取收费。内容等值判断比较当前项的完整固定内容（包括 metadata），不作语义相似合并；实现需覆盖 undefined／缺失、-0、普通／null 原型等支持域差异，不能直接照搬只处理字符串模板时的假设。对象键的插入顺序不单独成为内容变化；缺少 metadata、显式 undefined 和空对象不靠 JSON 意外归一化。

### 固定值不是序列化承诺

当前 `Stable<T>` 支持的值比 JSON 更宽。普通 JSON 会删除对象中的 undefined、把数组中的 undefined 变成 null、将 -0 变成 0；当前 Records 值检查及 CP 的 `CheckpointValue` 也不等于整个 Stable 域。

建议按现有职责处理，不为 Memory 前置一个通用序列化平台：

- 实体持有完整固定内容，未安装持久能力时不强制经过 JSON。
- 持久及 CP 对其承诺恢复的材料采用明确 codec，必须保真，包括固定请求和凭据。业务可将自己的 metadata 定义为明确的 JSON 子域；声明支持更宽值域时，适配器必须提供对应编码。不能仅因为能固定就宣称能直接保存。
- 编码支持域、往返及容量检查应在适配器执行外部提交前完成；不支持的值不能先写成功，再在记录或返回时才被发现。
- 可预检的编码拒绝宜在进入持久端口前完成。若由 `commit` 抛出，实体没有证据区别“编码尚未写入”与“已提交但回执失败”，只能按持久端口故障保守处理；不能凭异常文案自动恢复写权限。
- 记录和 UI 允许明确投影成较窄 DTO，不必保存全部 metadata；投影不能冒充完整实体快照、固定操作确认或恢复依据。需要完整材料跨端时，另提供该材料明确的编码契约。
- 同一展示的 baseline 和增量使用同一投影；更新替换该项展示内容，不合并保留旧版本已去掉的可选字段。

实现时需要验证这些边界，但不需要改变 Frame 值域，也不把任意元信息的序列化义务隐藏到 View 或 Invocation 中。

## 6. 持久不确定是需要显式决定的行为

当前 Memory 的 `commit` 抛错会变成 `PersistenceError`，本地不安装。但当前实例仍允许后续写入，且本地 `confirmFixed` 可以返回 undefined。存储已提交但丢回执时，不能由这些本地状态推断“没写入”。

推荐迁移时采用保守的实例限制：

- 持久端口异常／非同步成功后，该实例拒绝继续写入，直到宿主从权威存储重新载入一个实例。
- 已经得到的固定材料仍有效，不把它们撤销。
- 不把故障实例的本地旧 snapshot 当作权威存储基线；不自动 retry、清空或新生成 ID 补写。
- 对当前读取与未找到回执，不再宣称权威的最新／不存在；最小处理可以直接拒绝这些查询，诊断访问另行表达。
- 已知成立的旧回执不因之后一次不确定提交变成未成立；是否保留单独的历史确认入口应按实际恢复使用点确定。

这是 Memory 持久能力自身的边界，不新增所有实体共享的状态机。它会改变现有测试中“端口失败后在同一实例再次写入”的行为，因此不能伪装成内部优化。建议在实施前将该选择作为明确契约核对。

发布阶段失败不同：内容与回执已经安装，应保留真实结果，继续尝试其他通知；相同固定操作随后可以确认原结果。不能把发布失败也当作未提交。

## 7. View、CP、观测及类型归属

### View 与 CP

`MemoryViewSource` 保留 source ID、明确 scope、集合 sequence 的版本检查。summary 不再强制 topic，可缺省或由适配层提供；read 返回准确项身份及固定内容。单项更新、来源元信息修改和 View 成员变化分别表达，互不自动级联。

CP 保存取得的固定材料或准确固定操作依据，不要求恢复活实体，不增加历史正文查询。涉及效果确认的恢复仍由宿主提供权威持久事实；仅保存引用不会自动获得正文或重做资格。无需改变调用执行、恢复语义或 Frame；Invocation 中现有内容观测端口仍须随领域变化转交迁移。

### 领域变化与观测

Memory 自己定义变化事实，例如集合、sequence、项 ID、create/update、固定新正文、可选 reason。捕获继续使用 `ChangeCapture<MemoryEvent>`，不另建通用 EntityEvent 生命周期。

资源端口与调用层负责准确操作关联及故障／窗口语义，不能继续把新的 Memory 类型塞进低层实现。来源可能是某次资源操作，也可能是独立业务更新；没有来源就保留未知，不用全局当前调用或时间相邻补线。

### 依赖方向

- `FixedMaterial` 及真正共享的调用来源值可归 contracts；是否需要公开 `FixedReader` 由真实消费者决定，不强制类声明 implements。
- Memory 的正文、mutation、固定回执、持久状态和领域事件归 memory。
- `ViewSource` 仍归 view；memory 只实现这个可选切面。
- resources／invocation 不能反向导入 memory；它们需要中立的类型化事实转交接缝，具体 Memory 解释在适配与装配处。
- protocol 只保留真实跨端 DTO 与版本／接纳约束，不能为省一次映射而重导 memory 服务端包。

当前 `MemoryEvent` 从 protocol 贯穿 resources、invocation、runtime 与 records；MemoryContent 又包含对 conversation/FileReceipt 的依赖。内容形状改变时必须处理这些真实消费者，不能只改一个接口后填假 topic 或空 sources。正式迁移可拆提交，但必须形成没有循环依赖、没有静默信息损失的完整闭环。

## 8. 本次审查发现的具体接缝

下列问题已对照源码，并通过公开包的隔离进程探针复现；本轮没有修改生产实现：

1. [资源依据核验](../packages/memory/src/resource.ts) 在调用 `checkBasis(memories, expected, memories.sequence)` 时先读 sequence，再读 expected 的 getter。getter 内重入一次实体写入，可以让原 sequence=0 的检查通过，后续真正写入从 sequence=1 开始。新设计要把依据固定与核验纳入同一个写入保护边界。
2. [恢复固定凭据](../packages/memory/src/memories.ts) 目前核对范围／数量／ID 存在，但没有核对请求能否产生该回执；空 changes 搭配非空实际变化 IDs 可以被 restore 后确认。迁移须补请求位置对应的反例，不用当前正文检查旧操作。
3. “存储已收提交但回执抛错”的探针中，本地 sequence 仍为 0、confirmFixed 返回 undefined；提交参数已经含有固定回执。这证明的是本地状态不能判断外部结果，不是证明某个具体 SQLite 实现真的丢过回执。

这些应成为 memory 包自己的回归。它们与更换正文模板是不同的改动依据，不需要等全仓实体迁移后才暴露。

## 9. 整体迁移审查

结论：这个领域边界没有发现结构性阻碍；有真实接缝需要随迁移完成。以下是实现前置与验收项，不表示本轮已经修复，也不将每个改动点当作新的架构决策。

| 范围              | 现在的耦合或缺口                                             | 迁移要求                                                                          |
| ----------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| memory 本体       | 构造／restore／commit 依赖 Transcript，正文写死 topic 与来源 | 集合独立；项采用外层 ID＋value；保留批次、sequence、固定操作和静默载入            |
| 资源写入          | 依据在实体保护外核验；返回可能仍含活项                       | 进入实体保护后固定并检查请求；返回固定实际结果；加入 getter 重入回归              |
| 固定凭据恢复      | 回执与请求对应检查不足                                       | 核对准确操作、请求、实际变化位置和身份；旧格式明确拒绝                            |
| 持久不确定        | 本地未安装可能被误解为外部未提交                             | 第 6 节的实例使用边界须在实施时明确；不自动 retry 或推断未执行                    |
| metadata          | 固定值、持久值和展示 DTO 的值域不同                          | 按第 5 节显式编码或投影；不丢失被承诺恢复的内容                                   |
| 低层观测          | resources／invocation 直接传递 protocol.MemoryEvent          | 建立窄的类型化事实转交，保留来源、窗口、同步及故障策略；不反向依赖 memory         |
| records／protocol | 当前记忆及变化记录主动解释 topic、消息来源和文件凭据         | Memory 领域类型归包；记录／跨端类型表达明确投影，不填假字段、不整包转导服务端类型 |
| 私有客户端        | HTTP decoder 和 replica 仍重建旧形状                         | 局部更新记忆 decoder、baseline／增量；会话、提交队列、断线消费机制不需重写        |
| View／调用恢复    | 当前切面足够，业务 codec 仍包含旧字段                        | 保留 ViewSource 与 CP 机制；更新内容 codec 和业务契约版本，不改 Frame             |

具体代码入口：

- [Memory 状态与提交](../packages/memory/src/persistence.ts)、[资源端点](../packages/memory/src/resource.ts)、[集合写入与恢复](../packages/memory/src/memories.ts)。
- [observeMemory](../packages/records/src/memory/observe.ts) 当前直接访问 `collection.transcript`，并从 sourceIndexes 生成消息定位。应由明确投影替代这个领域假设。
- [ObservationReplica](../packages/client-runtime/src/observation/replica.ts) 当前从领域事件推导相同展示；baseline 与增量必须一起调整。
- [HTTP 观测校验](../packages/client-http/src/responses.ts)、[会话校验](../packages/client-http/src/session-responses.ts) 都消费旧形状，不是改完服务端类型就自动兼容。
- Invocation 的恢复观测分支也转交 memory 事实；这是观测适配面，不是 Frame 中增加实体数据。

### Lab 的独立迁移交接

只读审查了 Lab 的 Observer、Conversation、observer-content、SQLite 与记忆 UI。它们是明确的调用方，但不作为 CAPiX 自身测试或构建依赖：

1. 内容装配显式持有 Transcript 和 Memories；删除 `new Memories(transcript)` 及实体从属检查。宿主仍可保存二者准确 ID 的业务关联。
2. 两套提取策略各自决定是否保留 topic、来源及文件凭据。保留时放入自有 metadata，并由业务核验；若删除功能，提案 schema、提示词、校验和 UI 一起明确调整。变更理由与总结的来源不是同一个字段。
3. 两套 SQLite 目前将记忆正文整体 JSON 存入 body，没有 topic／source 专用列。更新正文 codec 和状态版本；宿主的 transcript_id 关联可以保留，不能要求实体继续持有 Transcript。
4. Observer 提交记忆时同步纳入 ActiveView，是其自己的组合持久策略，继续留在宿主。已退出项是否重新纳入仍由策略决定。
5. 业务 CP 更新保存材料、提案和确认 codec，拒绝旧契约；保留准确效果确认。界面标题和来源跳转由业务投影提供，缺少相应信息时省略组件。

Lab 在 CAPiX 形成公开产物后另行适配。CAPiX 不导入 Lab 源码；本轮没有修改 Lab。

### 最小验收

- 无 Transcript、无 topic、无来源也能新建、更新、读取并冷载入；更新保留 UUID，旧读取不变。
- metadata 的有效差异正确影响 no-op、sequence 和同操作请求冲突；不支持的字段／编码在提交前拒绝。
- 后项非法整批无效果；成功仅一次提交，整批安装后发布；首次固定 no-op 保存凭据，再次确认不重复写入。
- getter 重入、不可能回执、序号溢出、旧格式和损坏编码明确拒绝。
- 持久提交不确定与发布后故障分开验证；不因本地无回执而推断外部未执行。
- 单项及稀疏 View 读取不隐式枚举全集；旧 stamp 拒绝，退出 View 不删除项。
- CP 开关两种情况下读取值一致；明确 codec 往返恢复正确，固定效果确认不重做已成立操作。
- 记录／wire 投影的 baseline 与增量一致；准确来源与 isolate／propagate 行为不变，不能制造调用关联。
- 独立包回归、跨包类型负例及产物消费通过；CAPiX 验证不依赖 Lab。

## 10. 推进顺序与验证状态

领域含义、外层 ID、无保留 topic 和不强制来源已确定，不需要继续扩展记忆分类。

1. 先落实两个实现接缝的最小接口：持久／CP 的 metadata 编码与观测投影分开；低层领域事实转交保持类型匹配。第 6 节的提交不确定行为仍须明确记录为契约调整。
2. 在 memory 包内形成独立的当前读取、整批写入、固定确认和静默 restore 闭环，补反例及完整返回／事件预算。去掉强制 Transcript／文件来源，保留批次与凭据能力。
3. 同轮接通资源、View、records、protocol 与仓库内真实客户端消费者。可拆提交，但合入结果必须没有依赖环或静默信息损失；不借机做客户端整体重构。
4. 更新当前文档、公开出口和产物消费测试，再向 Lab 交接新包及业务契约变更。旧格式明确拒绝，不做存量升级。

本次整体审查仅更新设计文档，没有改包 API、持久格式或调用行为，也未新增运行测试。上一轮 memory 包独立回归的 12 个文件、39 项测试通过；这是现行行为基线，不表示未覆盖接缝已经修复。前轮 Lab 的 36 项验证说明能力组合成立，不能代替生产写入与宿主持久能力的迁移验证。
