# Callable Checkpoint 与有限恢复

状态：2026-11-07，CP 载体与存储由 `@capix/checkpoint` 提供，调用事实发布与续接由 `@capix/invocation` 提供，Runtime 负责结构与恢复 Work 的装配。当前只接收 Frame v6；生产保存使用稳定事实的增量表示，完整 v6 Image 仍可显式冷导入。旧 CP 格式不读取、不迁移，也不进入执行恢复。普通调用仍只执行一次 run，旧 round 2/continuation 不复活。历史推演见 [Checkpoint 设计历史](checkpoint-design-history.md)；新对话服务已有显式 CLI/Web 恢复入口，不自动恢复旧提交。

本轮已增加独立被动 `CheckpointInstallation.feedback`，覆盖正常 CP、恢复活动及恢复建立前失败；原 observation 的严格策略和 Store 提交规则保持。Runner 已提供 `observation` 元数据订阅，output 与 observation 都带本次入口 `entryId`，不改变恢复沿用的 Context 身份。该改动只补交付接缝，不扩大可恢复范围，也不把原始 CP 事实直接作为客户端协议。完整出口区分见 [运行出口](runtime-ports.md)。

恢复的目标是：某次 Callable 工作中断后，依据已经保存的事实和声明的续接入口，继续推进该工作。重新建立 Invocation、Context 和资源访问是实现手段；不恢复原 Promise、闭包、调用栈，也不反序列化 Bound 结构。

当前验证覆盖材料准备、普通回答、文件处理与保存、澄清、记忆收尾和有限二次生成；维护预设有局部续接验证，不等于自定义维护已开放宿主恢复。**声明接入不代表任意时刻都能恢复：每次续接仍须取得准确子工作、已保存结果或实体凭据。**未知外部效果不重新执行，明确失败或取消不复活。

外部框架与早期候选路径保留在 [恢复机制研究](recovery.md)。运行、实体、交互和观测行为分别以 [运行边界](runtime-boundaries.md)、[持久化](persistence.md)、[外部交互](interactions.md)、[记录机制](recording.md) 为准。普通服务启动、提交和客户端接回的承诺保持不变。

## 包与协作边界

| 归属                | 内容与责任                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| `@capix/checkpoint` | Frame/Image/Head/Delivery、持久引用值、纯数据检查与复制冻结、CheckpointStore 和 MemoryCheckpointStore     |
| `@capix/contracts`  | 单次调用身份 InvocationIdentity，Codec、作者保存端口、refs、已核实事实等共同契约                          |
| `@capix/structure`  | 具名 point、state、resume.deps/uses/run 及 reception 的作者配置关联                                       |
| `@capix/invocation` | 消费稳定调用事实、发布新增正文与变化关系、核对固定调用契约、安装 Context/子关系、调用排他、续接与恢复观测 |
| Runtime             | 解算当前结构的 CP 配置，接线供给、子构造入口与恢复 Work，维护 Runner 入口占用                             |
| Observer 与独立实体 | SQLite 存储、对话资源依据、业务恢复资格、消息/记忆/文件固定效果确认、外部反馈读取                         |

`server/checkpoint` 只依赖 contracts 和通用值比较工具，不依赖 Runtime、结构、资源、观测或数据库。它核验保存值自身的一致性：完整直接子关系、refs 归属、固定 owner/contract/input、revision 比较提交以及终态不可推进。当前结构是否兼容、宿主内容是否仍允许继续，则由 Runtime 与宿主分别核对。格式检查通过不等于取得恢复许可，也不形成通用任意快照能力。

```text
work.checkpoint({ point, state, refs })
  → Runtime 的作者适配核验 point/refs 与阶段资格
  → invocation 取得固定事实，首次编码新增字段，按需提供本次 check 视图
  → checkpoint 核验增量 Commit 及完整逻辑额度
  → Store 按 revision 保存并返回本次写入回执
  → invocation 核对身份、修订、正文摘要，再发布 saved

runner.resume(contextId)
  → Store 读取 Head，完整重建并认证逻辑 Image 与 publication 引用依据
  → Runtime 用当前结构契约接线，invocation 核对保存身份、输入与直接归属
  → invocation 安装 Context 与关系，Runtime 签发恢复 Work，进入 point.resume
```

Store 保持同步宿主端口，未强制放入普通业务 deps。最终交付在业务工作窗口结束后保存；保存失败仍属于调用必须承担的机制故障。每次恢复沿用稳定 Store 对象以维持本进程排他，不用临时端点身份替代它，也不承诺跨进程租约。

持久类型、MemoryCheckpointStore、cloneCheckpoint*、checkpointReference* 和 CHECKPOINT_MAX_BYTES 从 `@capix/checkpoint` 根入口导入；Runtime 不再重导它们。CheckpointFact、CheckpointInstallation、CheckpointWriter 和 CheckpointRestoration 从 `@capix/invocation` 导入，Runtime 既有出口重导同一定义。其中 Fact 包含运行观测与内容事件，不能反向进入独立持久包。共同 Codec/Value/Contract 可继续从 contracts、structure 取得同一类型。`@capix/checkpoint/storage` 向宿主 Store 提供增量计划、完整重建与无损存储编码辅助，不拥有数据库或新的运行实体。

调用分包不增加恢复点或恢复范围。低层 Invocation 可以直接连接 CheckpointStore 和固定工作契约，不要求建立 Scene/Runner；完整框架仍由 Runtime 解算结构、检查资源与行动资格。`test/invocation-boundary-checkpoint.test.mjs` 验证新 Store、Context 与重建契约之间的续接：等待父层消费固定子交付、已接纳事实直接继续，以及缺失或不一致依据的拒绝。

## 当前实现与入口

内核 CP 保持可选；Observer 默认给新产生的调用安装保存端口。新建对话正常聊天即可产生真实 CP，已有对话之后的新调用采用相同规则，不给过去的任务补写 CP。Observer 启动不扫描或自动继续旧 QA，旧 Observer 未增加 HTTP 恢复界面；并排的新对话服务另有显式恢复入口，见 [新服务有限恢复](conversation-recovery.md)。

| 入口                                                                                              | 当前行为                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CallableDefinition.checkpoint`                                                                   | 声明稳定 `key/version`、输入/输出 codec、`points` 数组；每点独立声明 name、`state` codec、引用槽位及 `check(state,facts)` 和 `resume { deps, uses, run }`。 |
| `new Runner(scene, resources, interactions, { checkpoints: { store, observation?, feedback? } })` | 注入同步保存端口、原机制观察者及可选原始被动反馈。未安装时 `work.checkpoint` 为 undefined，原流程不变；订阅不能安装保存端口。                               |
| `runner.observation.subscribe({ receive })`                                                       | 消费 `{ runnerId, entryId, source, fact }` 固定元数据；CP 事实使用 source: checkpoint，保留 activityId。只实时消费，不回放、不替换 Store 或严格观察。       |
| `work.checkpoint({ point, state, refs })`                                                         | 当前运行或恢复工作阶段使用；固定输入、round、直接子关系与声明状态，检查后提交不可变 CP。保存失败属于结构故障。                                              |
| `runner.resume(contextId, options)`                                                               | 核对绑定归属、当前 head、版本和工作归属，重建本次活动与资源访问，进入声明点；遵守该 Runner 入口占用边界。                                                   |
| `work.children.resume(saved.ref)`                                                                 | 开放子 CP 建立续接；固定成功交付提供结果视图。缺失或明确失败/取消拒绝，不退化为重新发起。                                                                   |
| `TranscriptResource.append.applyFixed({position,messages})`                                       | 真实子接纳中由绑定取得父子身份；实体核对固定依据并返回原凭据，重复确认不再次追加。                                                                          |
| `MemoryResource.apply.applyFixed({position,changes})`                                             | 由资源端点取得当前 A 身份；整个批次与凭据同事务保存，重复确认不修改记忆或占用新顺序。                                                                       |

资源端点与 CP writer 保持 phase/round 访问窗口。直接子接纳通过私有异步范围关联固定操作，支持并行接纳；逸出已结束接纳的回调不能借用后续接纳身份。没有增加新的恢复编排器或通用 resume/run/accept 预设，声明共享自己的正常阶段函数，Invocation 仍处理父子运行机制。

作者恢复点使用 `checkpointPoint<Kind, Input, Output>()`，具名点通过对象注册和保存；跨进程再以所属契约和点名核验。resume 接收本阶段 Work、已解码业务 state 和准确引用槽位，正常和恢复均经相同的 child.invoke 或精确 run/accept 接缝。普通 Work 不再暴露轮次或处理器状态，ResumeWork 的历史字段仅用于恢复核对。完整作者入口见 [可调用结构](callable-structures.md)。

当前新保存格式为 **Frame v6**：逻辑 Image 仍保留完整输入、currentInput、直接关系与 state/refs；物理表示由固定值块、当前关系记录与 head 组成。直接关系与业务 state/refs 分开，保留调用进度和子失败已经完成的 `handled` 接收事实。Frame v6 保留 continuation/前轮异常诊断字段，但执行恢复明确拒绝 round !== 1 或携带 continuation 的镜像；保留字段不等于支持旧 CP 格式或复活旧执行模型。子声明由父 checkpoint key/version 与去重后的固定声明位置关联，不依赖 JS 身份、key 或同名契约。父接纳契约位置及编码值继续保存，owner 与子身份使用 kind: scene/group/node；成员位置属于固定父声明。新进程必须提供兼容声明；同版本任意改动业务实现不在可检测承诺内。

v1/v2/v3/v4/v5 CP 在格式边界明确拒绝，不保留旧 v5 只读解析路径，也不把旧原引用语义升级为稳定事实。宿主数据库同样只接受当前格式：旧库拒绝打开，不升级、不清空、不覆盖。当前格式库内的正式内容和记录按各自契约读取；它们不授予调用恢复资格。

父可在 `checkpoint.receptions` 登记 `reception(child, { check, encode, decode })`。进入 receiving 即固定本次契约；accepted 保存值经该 codec 编码，恢复先核对本父注册位置和准确子声明位置，再 decode/check。`facts.children.accepted(ref, contract)` 在恢复点 check 与 resume 中均取得已核验的稳定 V（冷恢复重新解码），包含合法 undefined。它要求契约匹配，不能将旧 raw 接纳补成 typed 接纳。raw accept 使用默认稳定数据编码，仍不能事后补贴具名接纳契约。

普通接纳先将回调结果固定为 Stable<V>，再同步检查并安装；不开 CP 也相同，不再保留作者原对象身份。`reception.check` 只依赖固定值及已绑定参数，返回值不替换接纳值；异步/thenable 拒绝，当前外部业务条件应在业务接纳或后续推进中判断。首次发布编码时重新检查解码值并要求往返不改变已成立的值，后续热保存不重检旧接纳，冷恢复重新解码/检查。保存失败不撤回已接纳值或实体效果，也不授权再次接纳。receiving 的续接只能使用已固定的同一契约；需要重入实体写入时，仍由 `applyFixed` 等实体凭据保证，契约本身不提供幂等性。同一契约不可重复登记，注册顺序或含义变化需要提升父 CP version。

`work.children.invoke(child, input, { result: { failed }, reception })` 的失败分支成功返回后，子调用仍是 `returned: failed`，父关系另记 `reception: handled`。v6 保存这两个独立事实及固定的接收值；恢复用 `work.children.facts.handled(ref, reception)` 读取经契约解码和检查的 V，不再次调用失败来源或 `failed` 回调。接收回调还在执行时不能保存该同轮失败，普通 raw 接收值仍需符合纯数据边界。`handled` 不代表子成功，也不使失败子调用重新可运行。

CP 保存或最终交付落盘失败不属于可由业务 `result.failed` 处理的失败。调用保留必要机制失败，父层不能用替代正文将它变成成功；磁盘故障与原业务已经产生的内容或外部效果分别记录，不承诺回滚。

若 Group 交付的是后代 Node 的失败，直接关系仍属于 Group，失败诊断保留真实 Node 的 `failure.contextId`。该诊断 ID 只解释来源，不能作为父层直接子引用；`refs`、接收契约和恢复目标仍按完整直接关系精确核对。闭包不会被持久化：业务必须注册明确的点和续接处理，并在保存点之后使用已保存事实推进。

## 内核事实与保存

持久契约见 [checkpoint/contract.ts](../server/checkpoint/src/contract.ts)，运行安装与观测见 [invocation checkpoint/contract.ts](../server/invocation/src/checkpoint/contract.ts)，作者配置见 [structure definition/checkpoint.ts](../server/structure/src/definition/checkpoint.ts)。调用事实与业务 state 分开，逻辑镜像包含全部直接子关系，热保存只发布变化，不做正文裁剪。支持运行点、等待关系、成功返回/接纳关系和已经完成处理的子失败。业务循环进度属于 point state；它不重建活异常、不让失败子调用复活。尚未处理或正在处理的失败、结构故障及取消不能当作开放恢复点。

返回关系与最终交付保存真实子 round、phase、currentInput，不能从较早 CP 或父 round 推测。固定交付视图不伪造原 execute 中间结果或未保存的后代。GenerateAnswer 的显式再次生成核对原拒绝码、诊断与真实 handled 关系，恢复不重置次数或产生第三次生成。

`@capix/checkpoint` 提供 `MemoryCheckpointStore`，服务提供 `SqliteCheckpointStore` 并直接实现同一包的 CheckpointStore。SQLite CP/head 独立事务复用宿主 WAL/FULL 独占连接，与内容实体和模型交互的提交边界分开。每个完整逻辑 image、delivery、对话构造依据分别限制 8 MiB；Image 同时保持100000值、深度64及4096条直接关系上限，物理块共享仍按逻辑出现次数计费；拒绝 getter、函数、活实体、循环和超深结构。head 按 revision 比较更新，终态不可再推进；宿主复用同一端口并独占恢复入口，不承诺跨进程租约或多写者接管。声明版本不兼容明确拒绝，不自动迁移旧 CP。

### 固定事实与首次持久表示

输入在调用构造的 capture/refine 之前固定；返回候选在内核取得之后、清理及最终交付确认之前固定；父层 accepted/handled 在回调返回后固定并核验契约。真实异常继续按原对象传播，只将诊断固定为数据。CP 开关不改变这些含义，也不深冻结端点、实体、Work 或闭包。值域、内容限额与固定失败语义见 [稳定调用数据](runtime-boundaries.md#稳定调用数据与事实成立)。

每份固定事实第一次需要发布时才形成持久编码，立即固定 codec 的返回值、解码为稳定值并核验数据等值。合法 undefined、缺失字段与 -0 不得因 codec 往返被合并；默认无具名 codec 的数据路径对必要例外使用带标记的编码，显式 codec 保持自己的格式。进程内原型与 DAG 身份不属于持久值等值承诺。随后保存使用这一事实与已绑定契约的准确表示，不再次运行旧字段的 codec；这不是对任意可变对象或任意 check 的结果缓存。

Context/Relation 是事实所有者。CP 只记录已成立内容，不在保存时重新从作者可变原对象推测历史。孩子没有自己的 CP 时，父保存仍可持有已经成功交付或处理的直接关系正文；不能强制把一切子值改成子 Store 的链接。等待中的孩子仍要求准确可恢复契约，缺少首份子依据不自动重做。

### 单次保存的认证与确认

生产 Invocation 使用同一 `Store.save(commit, expectedRevision)`：v6 Commit 带新增值块、发生变化的当前关系、固定头字段及当前 state 的块引用；refs 可以是完整块，也可以是具名槽位指向的选择版本及本次出现项增删。Store 在同一事务中核对旧 head、固定 owner/contract/input、关系身份/不可逆进度、引用归属与完整逻辑额度，然后写块、更新关系、选择和 head。增量 scope 不得改变 round/continuation；保留字段不等于重新开放旧多轮执行。

旧 input、returned、accepted/handled 正文及已固定诊断不因其他孩子推进而重新编码、解码或压缩。关系状态变化只更新该关系的元数据，仍引用已发布字段。完整逻辑 8 MiB/100000值/深度64/4096关系限制通过经正文认证的统计组合核验，不把物理去重后的大小当成额度。新块按真实正文计算 digest/统计；同 ID 异内容、缺失/退休正文或不准确引用拒绝。

作者入口保持 `work.checkpoint({point,state,refs})`，返回 void；低层 writer/Store 返回确认回执。**state 每次完整提交，point.check 每次执行。** many 的数组写法表示完整替换，也可以通过 `work.checkpoint.select(definition, saved?)` 建立本次调用的有序选择，再以 `add` / `remove` 增量调整准确出现项。重复引用保留；切换点时使用本次明确选择，不隐式继承旧点；同一选择可显式供兼容槽位使用。只有准确提交回执才推进已保存依据。查询按需取旧事实，many 的 `length`／索引／`at` 不强制物化全部内容；遍历及 `children.values/list` 仍承担实际读取成本。按 point 的作者认证 basis、实体前缀分块没有加入，不能据此宣称所有作者代码已具有常量成本。API 与恢复规则见 [增量引用选择](checkpoint-selection.md)。

`point.check(state,facts)` 必须同步完成；Promise/thenable 在提交前拒绝。其查询端口只在这次 check 有效，结束后不能再查询或借用后续保存；已经取得的稳定数据可以保留。保存窗口拒绝同 writer 重入及关系变更，并在作者 codec/check、captured 通知之后重新核对活动、阶段和修订。state/point/refs 改变即使没有新关系也要检查当前组合；不能用“没有 delta”免掉 check。

`read(contextId)` 仍返回完整 `CheckpointHead`；v6 Head 另带可序列化的 `publication` 引用元数据（完整当前关系引用、无正文块），供恢复后继续复用原块。冷读取完整验证存储正文、digest、统计、引用、逻辑 Image 以及 publication 与 Image 的一致性；复制或传输后须重新认证，不能靠 WeakMap 身份决定能否恢复。支持 v6 的自定义 Store 及 read 包装也须保留这份纯值元数据，无需透传原 JS 对象；本地 WeakMap 只省去同一已认证对象的再次冷核验。该元数据不授予新的恢复权限，也不是第二份调用状态。缺失的存储块仍由 Store 拒绝；只有当前结构和宿主资格核验通过才可继续。

`save` 返回 `CheckpointSaveReceipt`，`finish` 返回 `CheckpointFinishReceipt`；包含准确 contextId、checkpointId、revision、digest，终态另含 status，不附带正文。v6 使用 `checkpointCommitReceipt` / `checkCheckpointCommitReceipt` 绑定准确增量与新块摘要；完整 Image 冷导入继续使用 image receipt，`finish` 沿用独立交付回执。摘要关联编码内容而非证明介质已落盘。显式完整 v6 Image 保存是冷导入路径，逐项核验且承担全量成本；旧版本 Image 明确拒绝。生产 Invocation 只提交 v6 Commit。

一旦进入 Store 写口就按“可能已提交”处理。抛错或回执拒绝时，调用不自动重试、不写伪造失败终态，不把未知当作回滚；必要机制故障不能被 `result.failed` 降级。确认成功后的严格 saved 通知失败仍沿用既有失败收尾。内容固定、正式交付、实体落实与持久提交保持分离。

### 正文保留与宿主格式

2026-11-06 的保留修订将历史完整镜像收敛为每调用当前 head，它只减少存量，不减少当时的全量计算。2026-11-07 的 v6 增量表示在此基础上减少热路径的重复正文处理；两项收益应分开测量，不改作者 save/finish 次数或恢复点密度。

| 内容                      | 当前规则                                                               |
| ------------------------- | ---------------------------------------------------------------------- |
| 当前 head 与关系          | 每调用保留当前版本，冷读取重建完整逻辑 Image                           |
| 固定值块                  | 当前 head/关系仍引用时保留正文；引用归零在同一提交中退休正文           |
| 历史 image / 已退休块身份 | 保留 ID；块另留原 digest，拒绝同 ID 异内容；准确同内容可以显式重新供给 |
| 终态 delivery             | 保留，当前 head 及其引用正文继续存在；终态不可推进                     |
| 已完成根与子 head         | 不做整树自动退休，不把完成标记当成可删除所有依据的证明                 |

Memory 和两个 SQLite 实现遵循相同逻辑。Conversation SQLite 当前为 schema 8，包含值块、当前关系、选择及出现项表；Observer 的独立格式见[持久化](persistence.md)。两种宿主只创建空的新库或打开形状完整的当前格式库，旧版本和不匹配表结构均拒绝，不执行升级或清空。增量元数据含校验摘要，正文块和最终交付使用保留 -0 的内部无损编码；Conversation 正文再以有界 Brotli 存储。归档计数在同一事务涵盖当前头、值块正文、块元数据、关系、选择、出现项和交付。

v6 热写按本次变化读取所需元数据，冷读取完整认证；不存在旧 v5 镜像推进缓存或旧格式读写分支。

两个 SQLite Store 的 v6 热写可复用关系行的已认证解析结果。缓存按具体 Store/连接及 owner/child 隔离，默认最多4,096项、16 MiB计费材料；每次仍从当前事务读取准确 `child_id/ordinal/body`，逐字一致才复用。它不以“身份不变”为由跳过 SQL，也不将 waiting/accepted 等状态视为不变；变化行重新解析，缺失行不命中；完整 refs 数组逐项核验，增量选择按其提交依据核验本次出现项变更，二者不因解析复用跳过归属检查。缓存只接纳实际读出的行，不预装待提交关系；事务失败（包括 COMMIT）清空，finish 释放该 owner。Conversation 关闭主动清空；Observer 连接由宿主持有，关闭后的端口访问失败会清空，若宿主继续持有未再访问的 Store，残留缓存仍受上述总额限制。冷 read 完整核验且不借用缓存。计费材料不是精确 JS 堆内存上界；完整 refs 依旧承担 O(R) 读取与核验成本。

任何事务失败整体回滚；回执失败仍不意味着回滚。当前 head 缺正文、引用缺块或数据不一致均拒绝，不回退旧镜像。旧 image 身份行、块墓碑、关系、head 与终态仍可能增长，内存和冷恢复也未承诺恒定规模。不自动 VACUUM，不保证文件立即缩小；分叉、整树退休与外部事务继续是独立议题。

保存粒度仍按恢复安全、覆盖范围与允许重算内容分别验证，见 [恢复承诺与保存组合验证](checkpoint-recovery-coverage.md)。增量表示不自动扩大宿主资格，不通过保存次数下降来代替恢复切点证明。

## Observer 声明覆盖

| 范围                                           | 保存与续接位置                                                             | 不允许的替代                                        |
| ---------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------- |
| Scene / Task                                   | Scene 等待准确 Task；Task 保存准备材料、决策、能力调用、接纳和收尾进度     | 不重复 R 的输入追加，不根据最近调用或文本猜身份     |
| 理解请求 / 决策 / 显式选择预设                 | 模型与接纳等待、已接纳结果；E 保留步数、候选反馈和已选路径                 | 不重新理解已固定决定，不重置预算                    |
| 活跃材料准备 / 维护预设                        | 准备等待与固定结果；维护等待（子 O 有 CP 时）、accepted、completed         | 完成后复用原材料；无固定索引凭据时不猜测已落实      |
| 文件预检 / 文档处理                            | 元数据检查、读文件与生成子调用等待，已取得结果                             | 已保存读取沿用原正文；没有读取结果不能假设文件没变  |
| 回答生成                                       | 组装、准备请求、请求模型、接纳等待与结果；两次业务尝试的已保存状态分别核对 | 首次拒绝仍是拒绝，不因恢复增加模型调用额度          |
| 模型请求 / 发起 / 跟随                         | 固定 Interaction 身份、请求与用途，读取原反馈                              | 无反馈、交互缺失或请求不一致时不重发                |
| 保存结果 / 创建文件                            | 保存等待、固定创建前的 `prepared` 点和创建凭据                             | `pending` 表示结果未知，不从文件存在/内容相等猜完成 |
| 提取 / 落实记忆                                | 准备、模型、接纳、批次落实等待；ApplyMemory 的 `prepared` 点               | 不重新提取已固定批次，不重复创建或更新记忆          |
| 组装上下文 / 准备与接纳模型结果 / 文件读取检查 | 保存纯数据成功结果，供本层完成和父层接纳                                   | 子尚无 CP 或最终交付时不自动重新执行                |

E 已移除原先覆盖决策、文件和记忆的 `continuationBarrier`。各等待点核对准确声明、key、固定子输入与已接纳进度；已接纳点核对具体阶段。`answerAccepted` 不能改名为 `completed` 跳过记忆收尾。澄清/不支持结论也使用固定消息追加，恢复不会多发一条澄清。

FunctionDecision 可保存纯数据候选，候选是否可执行仍由 E 接纳逻辑判断，CP 不抢占原业务审查。Observer 宿主目前仍拒绝恢复注入的自定义决策函数，因为没有固定该函数实现版本的契约；默认决策链可恢复。注入自定义维护也暂不允许宿主恢复，即使策略 O 自带 CP；当前没有完整版本化其宿主配置与实现的恢复契约。

当前 Observer 的 Scene/Task checkpoint 契约为 _*observer.conversation.scene version 5 / observer.conversation.task version 7 / observer.generate-answer.* version 5_*；新保存为 Frame v6，声明版本与格式版本分开。生成回答把 retry 次数、原拒绝与 handled 关系保存为业务状态，恢复不重置次数、不产生第三次请求。旧声明版本及旧多轮镜像拒绝续接，不自动迁移。默认服务保持单任务的恢复登记，不因 Group 可嵌套就承诺宿主支持任意多任务恢复。

准备 O 的 completed、E 的 preparationAccepted 及已返回交付保存同一份固定材料。恢复核对材料来源及当时值，不读取当前活跃索引替换它。R 从已保存的 executionWaiting 续接准确 E，不重复 append；正式输入已写入但尚无首个 R CP 的窗口仍不承诺恢复。

## 实体落实与固定依据

消息依据/凭据与消息同事务提交。E 接纳后的 CP 保存对应凭据，恢复向 Transcript 核实；CP 自身不能证明实体已经写入。

记忆按固定 A 身份与效果位置保存完整变更批次、实际变动的 memoryIds、起止 sequence。整批预检查并提交，无变化 update 不占顺序；空批次也可确认。服务保存初始记忆快照，恢复时只允许原 E 子树中、与 ApplyMemory 原输入一致的连续固定批次；同时纯数据核对这些批次之后的当前正文，避免只凭序号认定内容一致。准备材料及其下游仍使用当时的消息/记忆值，写入口访问真实实体。

文件创建由 WorkspaceFiles 的独立日志持有固定操作、路径、正文的 bytes/digest 与凭据；待创建正文由 A 的 CP 输入保存。先登记 pending，再发布并同步文件与目录，最后保存成功凭据。中断后，成功凭据直接确认历史结果，不重新创建；没有日志时可执行原 `prepared` 操作；只有 pending 时明确 `FILE_CREATION_UNCONFIRMED`。文件系统与 SQLite 不是同一事务，这个未知窗口仍保留，不提供任意外部效果恰好一次保证。历史凭据不保证文件此刻仍存在。

`ConversationCheckpointRun` 保存对话与 R/E 身份、输入位置、固定模型配置、声明配置、原文范围/指纹、记忆身份/顺序/当时正文。核对本轮固定原文前缀与正式输入，并验证已准备材料属于原范围和允许的记忆版本；原文定位不是模型材料集合。恢复允许本 E 已确认的固定助手追加与上述记忆批次，拒绝后续新 QA、分段变化或其他写入。复用 E 最终交付不重新建立 E 工作。文件工作区根路径及读写限额通过宿主指纹核对；改变 files、工作区、限额或 maxDecisionSteps 均拒绝。指纹不是文件内容快照，当前访问仍遵守原文件端点的限制。

活跃索引的维护目前没有 `applyFixed` 操作凭据。accepted 点在索引落实前保存决定，恢复时仍要求原复合依据成立；若索引已经改变，即使目标成员碰巧相同，也拒绝把它当作原操作确认。completed 点保存落实后的不可变材料，续接直接返回该值，不再应用索引。不把源内容同事务持久化与索引维护的 CP 原子性混为一谈。

## 宿主入口、严格观察与被动反馈

```ts
const environment = conversations.open(conversationId);
const runs = environment.checkpointRuns.list(conversationId);
const rootId = runs[0].rootContextId;
const head = environment.checkpoints.read(rootId);
// 宿主确认旧活动已停止，并明确选择有可用依据的未终结工作。
const unsubscribe = environment.checkpointObservation.subscribe(rootId, (snapshot) => {
  // 有界元数据：当前活动、阶段、恢复关系，不含 frame 或业务 IO。
});
const answer = await conversations.recover(conversationId, rootId);
const observed = environment.checkpointObservation.query(rootId);
unsubscribe();
```

取消不能充当中断：明确失败、取消和完成的顶层工作均不复活。恢复入口不接收旧 Submission 进展通道，不伪造旧 started/input/answer/completed；新实体变化仍能经原同步出口读取。客户端接回与服务执行恢复独立，旧 submissionId 不因 CP 存在就变得可跟随。

内核独立 `CheckpointFact` 出口带稳定 owner 与本次 activityId，区分正常和 recovering 活动。`installed` 表示历史关系基线，`child-restored` 区分续接与固定交付复用；历史安装不重演 started/returned/accepted。恢复调用事实不写原 Recorder/Invocation changes，实体新变化经自身出口发布，旧凭据确认不重复发布。内部事实可能含 IO，不能直接作为公开协议。

当前安装有三个不同端口：

| 端口                  | 权限与数据                                            | 失败和生命周期                                                                           |
| --------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `store`               | 读取／提交固定 Image、Head 和最终 Delivery；恢复依据  | 必要保存失败影响调用。MemoryCheckpointStore 只保证本进程保存，跨进程持久性取决于宿主实现 |
| `observation.observe` | 同步观察原始 CheckpointFact；可选 isolate / propagate | 保留现有机制观察策略，故障停用该会话；不参与业务接纳、不回滚已提交数据                   |
| `feedback.receive`    | 被动消费同一份原始 CheckpointFact；可选 failed 通知   | ProgressChannel 独立隔离故障，不改变保存或交付，也不因严格观察停用而被连带关闭           |

同一 CP 事实只建立一次，feedback 与 observation 共享原事实对象、activityId 和 sequence。原始反馈是同步借用出口，仍可能含 Frame、实际 IO、异常和资源 describe；不能把它直接排队作为持久或跨端数据。恢复调用向 CP 的转发层独立于消费者停用状态，严格 activity/resource 观察失败后，后续真实失败收尾仍能交付给健康的被动端。恢复建立前的读取／契约核验／构造失败也通过该出口发布一次，仍保留原异常及严格观察异常的组合。

保存与通知保持三个不同边界：`store.save` 成功后的严格 saved 通知失败可使当前调用失败，但已保存 Head 不撤销；严格 finishing 失败可阻止随后成功 Delivery 的提交，进入失败交付路径；`store.finish` 完成后的 finished 通知故障被隔离，不能修改最终 Delivery。增加 feedback 不改变这些边界，也不重新开放已终结的 CP。

Runner 在单次入口固定反馈关联，将原始事实同步投影成只读元数据。`source: 'checkpoint'` 下的 installed 只包含轮次、下一子顺序及子数量等基线摘要，不暴露 Frame；activity/resource 保留对应的轻量事实；内容变化只给身份／版本／范围，不携带正文或 describe。正常业务注释使用 `source: 'business'` 且只暴露事件名称；恢复路径原本没有业务注释出口，本轮不增加对应 CP 分支。Runtime 的普通反馈接线只有接收器，不能替换 Store、原严格观察或资源供给。

每次 run/resume 都有新的 entryId，CP 的 contextId 仍沿用原工作身份，activityId 仍属于具体 CP 活动。`runner.output` 的 completed、CP 最终 Delivery 和入口 settled 分别表达输出完成、Store 固定交付与 Runner 的实际返回／拒绝；settled 包含严格 released 观察之后的结果。entryId 是关联值，不是新的 Run 实体、恢复许可或幂等凭据。

订阅可以跨 run/resume 保留，也可以运行中加入；只接收此后的事实，解除订阅不停止调用。没有订阅者时跳过投影，不读取 describe 或保存历史，但仍保留固定接线的必要开销。Runner 不汇总独立 Interaction 的晚到反馈，也不取得它的生命周期；需要关联时仍由宿主组合。

Observer 默认绑定 `CheckpointObservation` 元数据载体：按真实祖先归属查询/订阅，每次最多保留 1024 事件、256 活动，每个安装基线最多 64 个子关系，明确标记裁剪；微任务交付、消费者故障隔离。当前只保留本进程数据，未接 HTTP 或可视化页面，不承诺跨进程观测日志。宿主仍可额外注入原始观察者。CP 保存与观察失败分开：默认 isolate，可显式 propagate；最终交付提交后的通知失败不能改写已固定交付。

该 Observer 载体是既有服务投影，与 Runner 的实时订阅并存；本轮没有将其记录／历史能力搬进 Runner，也没有自动迁移原服务的观察安装。

## 验证与剩余范围

新增 [checkpoint/feedback](../test/checkpoint/feedback.test.mjs) 定向覆盖事实对象／活动／序号一致、被动消费抛错与异步错误隔离、严格 captured/saved/finishing/finished 的提交边界、恢复 activity/resource 故障后的真实收尾，以及 Invocation 建立前失败的独立交付。[runner-observation](../test/runner-observation.test.mjs) 覆盖入口关联、恢复活动区分、订阅隔离和实际入口结局。这里列出实施覆盖范围，不据此声称本轮全仓验证完成。

`test/checkpoint/coverage.test.mjs` 使用真实 ObserverConversations、SQLite、WorkspaceFiles 与声明链，只有 Provider 为 mock。子进程在材料准备、理解、决策、预检、读取、模型反馈、消息追加、文件创建、记忆提交与父层接纳等位置退出，新进程从宿主恢复。断言模型次数、输入/回答数量、文件凭据、记忆身份与顺序，以及恢复活动归属；澄清和第二次生成另有覆盖。`fixedEffects`、`fixedAppend`、内核历史关系与宿主内容检查测试覆盖事务失败、重复消费、未知窗口及数据冲突。

`test/active-content.test.mjs` 覆盖索引冲突、不可变捕获、源写入及 SQLite v6 事务/恢复；`test/active-context-operations.test.mjs` 覆盖普通 O 策略、等待/接纳/完成点的局部续接与索引歧义拒绝。`test/integration/active-context.test.mjs` 覆盖维护先于捕获、默认完整材料和不隐式裁剪；跨进程覆盖准备结果、父层接纳以及文件/记忆后续链路。均使用测试 Provider，不请求真实模型。

剩余边界是明确限制：子层第一次 CP/交付之前的未知窗口、未保存的外部反馈、文件发布后仅有 pending、未版本化自定义决策/维护、活跃索引落实后尚无 completed CP 的歧义窗口、旧提交交付和自动恢复。这些不以“已有 CP”自动获得支持。正常聊天可验证保存与观测接入；恢复正确性以受控中断测试验证，不能只看普通对话是否成功。

## 三个独立提交边界

```text
子调用返回 → 父操作的 result 接收 → 业务实体落实 → 父接纳结束 → 保存父 CP
                 │                     │                │
              真正的返回            固定效果凭据       state + 全部关系
```

实体提交、父接纳和 CP 不声明成一个事务。实体已落实而父 CP 尚未保存时，恢复只能用相同的固定操作确认；不能凭文件存在或消息内容相等猜测完成。父 CP 已保存 accepted/handled 时，消费该事实，不重新执行原接收回调。

需要等待恢复点时：先 create，保存准确子引用，再 call.invoke；需要在返回后单独检查或写入时保留 run/accept。waiting 关系不保证子已有首份 CP/最终交付；缺少续接依据必须拒绝，不能退化为重新发起。结构的成员顺序、点名、reception 注册顺序或状态解释变动，需要提升相应父契约版本。

200 会话下的同步成本、完整镜像重复处理及连接时序调查见 [CP 容量问题调查](checkpoint-capacity-investigation.md)。该调查不改变本文的保存／恢复契约；减少恢复点、修改 Frame 表达或后台提交仍需独立设计。
