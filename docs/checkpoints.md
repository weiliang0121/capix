# Callable Checkpoint 与有限恢复

状态：2026-10-27，CP 载体与存储由 `@capix/checkpoint` 提供，活调用捕获和续接由 `@capix/invocation` 提供，Runtime 负责结构与恢复 Work 的装配。Frame v5 保持格式，普通调用只执行一次 run；旧 round 2/continuation 的执行恢复明确拒绝。历史设计推演移至 [Checkpoint 设计历史](checkpoint-design-history.md)，其中旧 API 不再作为当前入口。自动恢复、旧提交交付与恢复 UI 尚未接入。

本轮已增加独立被动 `CheckpointInstallation.feedback`，覆盖正常 CP、恢复活动及恢复建立前失败；原 observation 的严格策略和 Store 提交规则保持。Runner 已提供 `observation` 元数据订阅，output 与 observation 都带本次入口 `entryId`，不改变恢复沿用的 Context 身份。该改动只补交付接缝，不扩大可恢复范围，也不把原始 CP 事实直接作为客户端协议。完整出口区分见 [运行出口](runtime-ports.md)。

恢复的目标是：某次 Callable 工作中断后，依据已经保存的事实和声明的续接入口，继续推进该工作。重新建立 Invocation、Context 和资源访问是实现手段；不恢复原 Promise、闭包、调用栈，也不反序列化 Bound 结构。

当前验证覆盖材料准备、普通回答、文件处理与保存、澄清、记忆收尾和有限二次生成；维护预设有局部续接验证，不等于自定义维护已开放宿主恢复。**声明接入不代表任意时刻都能恢复：每次续接仍须取得准确子工作、已保存结果或实体凭据。**未知外部效果不重新执行，明确失败或取消不复活。

外部框架与早期候选路径保留在 [恢复机制研究](recovery.md)。运行、实体、交互和观测行为分别以 [运行边界](runtime-boundaries.md)、[持久化](persistence.md)、[外部交互](interactions.md)、[记录机制](recording.md) 为准。普通服务启动、提交和客户端接回的承诺保持不变。

## 包与协作边界

| 归属                | 内容与责任                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `@capix/checkpoint` | Frame/Image/Head/Delivery、持久引用值、纯数据检查与复制冻结、CheckpointStore 和 MemoryCheckpointStore |
| `@capix/contracts`  | 单次调用身份 InvocationIdentity，Codec、作者保存端口、refs、已核实事实等共同契约                      |
| `@capix/structure`  | 具名 point、state、resume.deps/uses/run 及 reception 的作者配置关联                                   |
| `@capix/invocation` | 捕获活调用关系、核对固定调用契约、安装 Context/子关系、调用排他、续接与恢复观测                       |
| Runtime             | 解算当前结构的 CP 配置，接线供给、子构造入口与恢复 Work，维护 Runner 入口占用                         |
| Observer 与独立实体 | SQLite 存储、对话资源依据、业务恢复资格、消息/记忆/文件固定效果确认、外部反馈读取                     |

`server/checkpoint` 只依赖 contracts 和通用值比较工具，不依赖 Runtime、结构、资源、观测或数据库。它核验保存值自身的一致性：完整直接子关系、refs 归属、固定 owner/contract/input、revision 比较提交以及终态不可推进。当前结构是否兼容、宿主内容是否仍允许继续，则由 Runtime 与宿主分别核对。格式检查通过不等于取得恢复许可，也不形成通用任意快照能力。

```text
work.checkpoint({ point, state, refs })
  → Runtime 的作者适配核验 point/refs 与阶段资格
  → invocation 捕获完整调用关系
  → checkpoint 固定并校验 Image
  → Store 按 revision 保存并返回本次写入回执
  → invocation 核对身份、修订、正文摘要，再发布 saved

runner.resume(contextId)
  → Store 读取 Head，checkpoint 核验保存数据
  → Runtime 用当前结构契约接线，invocation 核对保存身份、输入与直接归属
  → invocation 安装 Context 与关系，Runtime 签发恢复 Work，进入 point.resume
```

Store 保持同步宿主端口，未强制放入普通业务 deps。最终交付在业务工作窗口结束后保存；保存失败仍属于调用必须承担的机制故障。每次恢复沿用稳定 Store 对象以维持本进程排他，不用临时端点身份替代它，也不承诺跨进程租约。

持久类型、MemoryCheckpointStore、cloneCheckpoint*、checkpointReference* 和 CHECKPOINT_MAX_BYTES 从 `@capix/checkpoint` 根入口导入；Runtime 不再重导它们。CheckpointFact、CheckpointInstallation、CheckpointWriter 和 CheckpointRestoration 从 `@capix/invocation` 导入，Runtime 既有出口重导同一定义。其中 Fact 包含运行观测与内容事件，不能反向进入独立持久包。共同 Codec/Value/Contract 可继续从 contracts、structure 取得同一类型。

调用分包不增加恢复点或恢复范围。低层 Invocation 可以直接连接 CheckpointStore 和固定工作契约，不要求建立 Scene/Runner；完整框架仍由 Runtime 解算结构、检查资源与行动资格。`test/invocation-boundary-checkpoint.test.mjs` 验证新 Store、Context 与重建契约之间的续接：等待父层消费固定子交付、已接纳事实直接继续，以及缺失或不一致依据的拒绝。

## 当前实现与入口

内核 CP 保持可选；Observer 默认给新产生的调用安装保存端口。新建对话正常聊天即可产生真实 CP，已有对话之后的新调用采用相同规则，不给过去的任务补写 CP。启动不扫描或自动继续旧 QA，没有新增 HTTP 恢复接口或界面恢复按钮。

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

当前格式为 **Frame v5**：完整直接子关系与业务 state/refs 分开保存，保存单次调用进度和子失败已经完成的 `handled` 接收事实。格式中仍有旧 continuation/前轮异常诊断的读取类型，但新恢复明确拒绝 round !== 1 或携带 continuation 的镜像；格式可读取不等于旧执行模型可复活。子声明由父 checkpoint key/version 与去重后的固定声明位置关联，不依赖 JS 身份、key 或同名契约。父接纳契约位置及编码值继续保存，owner 与子身份使用 kind: scene/group/node；成员位置属于固定父声明。新进程必须提供兼容声明；同版本任意改动业务实现不在可检测承诺内。

v1/v2/v3/v4 CP 明确拒绝恢复，不自动迁移或重发。格式升级不改写旧 image；历史消息、记忆和可选记录继续读取。历史记录和格式诊断不驱动普通执行。

父可在 `checkpoint.receptions` 登记 `reception(child, { check, encode, decode })`。进入 receiving 即固定本次契约；accepted 保存值经该 codec 编码，恢复先核对本父注册位置和准确子声明位置，再 decode/check。`facts.children.accepted(ref, contract)` 在恢复点 check 与 resume 中均取得解码后的 V，包含合法 undefined。它要求契约匹配，不能将旧 raw 接纳补成 typed 接纳。raw accept 保留既有纯数据保存行为。

普通接纳只同步检查实际 V，保留原引用；不会编解码来替换它。保存失败不撤回已接纳值或实体效果，也不授权再次接纳。receiving 的续接只能使用已固定的同一契约；需要重入实体写入时，仍由 `applyFixed` 等实体凭据保证，契约本身不提供幂等性。同一契约不可重复登记，注册顺序或含义变化需要提升父 CP version。

`work.children.invoke(child, input, { result: { failed }, reception })` 的失败分支成功返回后，子调用仍是 `returned: failed`，父关系另记 `reception: handled`。v5 保存这两个独立事实及接收后的值；恢复用 `work.children.facts.handled(ref, reception)` 读取经契约解码和检查的 V，不再次调用失败来源或 `failed` 回调。接收回调还在执行时不能保存该同轮失败，普通 raw 接收值仍需符合纯数据边界。`handled` 不代表子成功，也不使失败子调用重新可运行。

CP 保存或最终交付落盘失败不属于可由业务 `result.failed` 处理的失败。调用保留必要机制失败，父层不能用替代正文将它变成成功；磁盘故障与原业务已经产生的内容或外部效果分别记录，不承诺回滚。

若 Group 交付的是后代 Node 的失败，直接关系仍属于 Group，失败诊断保留真实 Node 的 `failure.contextId`。该诊断 ID 只解释来源，不能作为父层直接子引用；`refs`、接收契约和恢复目标仍按完整直接关系精确核对。闭包不会被持久化：业务必须注册明确的点和续接处理，并在保存点之后使用已保存事实推进。

## 内核事实与保存

持久契约见 [checkpoint/contract.ts](../server/checkpoint/src/contract.ts)，运行安装与观测见 [invocation checkpoint/contract.ts](../server/invocation/src/checkpoint/contract.ts)，作者配置见 [structure definition/checkpoint.ts](../server/structure/src/definition/checkpoint.ts)。CPF 与业务 state 分开，捕获全部直接子关系，不做正文裁剪。支持运行点、等待关系、成功返回/接纳关系和已经完成处理的子失败。业务循环进度属于 point state；它不重建活异常、不让失败子调用复活。尚未处理或正在处理的失败、结构故障及取消不能当作开放恢复点。

返回关系与最终交付保存真实子 round、phase、currentInput，不能从较早 CP 或父 round 推测。固定交付视图不伪造原 execute 中间结果或未保存的后代。GenerateAnswer 的显式再次生成核对原拒绝码、诊断与真实 handled 关系，恢复不重置次数或产生第三次生成。

`@capix/checkpoint` 提供 `MemoryCheckpointStore`，服务提供 `SqliteCheckpointStore` 并直接实现同一包的 CheckpointStore。SQLite CP/head 独立事务复用宿主 WAL/FULL 独占连接，与内容实体和模型交互的提交边界分开。每个 image、delivery、对话构造依据分别限制 8 MiB；拒绝 getter、函数、活实体、循环和超深结构。head 按 revision 比较更新，终态不可再推进；宿主复用同一端口并独占恢复入口，不承诺跨进程租约或多写者接管。声明版本不兼容明确拒绝，不自动迁移旧 CP。

### 单次保存的认证与确认

`cloneCheckpointImage` / `cloneCheckpointDelivery` 对未知输入仍完整复制、校验和深度冻结；只有本包已经认证的准确同一对象才直接复用。认证通过私有 WeakMap 保存，不写入 Frame，不依据 TypeScript 类型、调用者冻结或业务对象身份；反序列化后重新检查。构件的及时固定、组合镜像的完整预算及关系核验保留，不缓存 codec 或 point.check 的结果。

读取与写入返回分开：`read(contextId)` 仍返回完整 `CheckpointHead`；`save` 返回 `CheckpointSaveReceipt`，`finish` 返回 `CheckpointFinishReceipt`。回执包含 kind、contextId、checkpointId、revision 和 digest；终态回执另含 status，不携带 image/delivery 正文。Store 适配器在真实提交成功后返回由 `checkpointSaveReceipt` / `checkpointFinishReceipt` 构造的确认。两者使用首次认证时已有 JSON 表达的 SHA-256；只缓存摘要，不长期保留第二份 JSON 正文。它是准确编码内容的关联依据，不是忽略对象字段顺序的通用语义摘要，也不能自行证明介质已经落盘。

Invocation 使用 `checkCheckpointSaveReceipt` / `checkCheckpointFinishReceipt` 核对准确请求及 expectedRevision + 1，正常保存后只保留修订和最后镜像 ID，恢复另持完整快照。自定义 Store 的旧 Head 返回必须迁移；需要恢复内容的测试、宿主和工具显式调用 read。Frame v5 和现有 SQLite 格式不变，旧存量数据不需要迁移。

保存入口固定修订基线，同一 writer 拒绝重入；穿过作者 codec/check 和 captured 通知后，提交前复核本次活动、阶段和修订。父字段也在每次 codec 返回后立即固定，避免后续 codec 复用临时对象改写已捕获值。Store 写口抛错或回执拒绝时，结果可能已经提交：该调用不再自动写入失败终态或重试保存，保留机制故障，不把失败解释为回滚。确认成功后的严格 saved 通知失败仍沿用既有失败收尾规则。

本轮仅消除同一完整镜像跨边界的重复认证。SQLite 仍读取并完整核验旧 head，CAS/终态/固定 owner-contract-input 检查、压缩位置、同步事务及持久成功后返回的承诺保持；未实现构件统计复用、增量存储或后台提交。

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

当前 Observer 的 Scene/Task checkpoint 契约为 _*observer.conversation.scene version 5 / observer.conversation.task version 7 / observer.generate-answer.* version 5_*；Frame 为 v5，声明版本与格式版本分开。生成回答把 retry 次数、原拒绝与 handled 关系保存为业务状态，恢复不重置次数、不产生第三次请求。旧声明版本及旧多轮镜像拒绝续接，不自动迁移。默认服务保持单任务的恢复登记，不因 Group 可嵌套就承诺宿主支持任意多任务恢复。

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
