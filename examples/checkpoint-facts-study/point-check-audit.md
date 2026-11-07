# Point 检查的职责与读取范围盘点

2026-11-07。承接[第六轮作者契约盘点](author-audit.md)和[第七轮 ToolLoop 策略验证](../../docs/checkpoint-tool-policy-validation.md)。本轮只读生产代码；本文不修改 point、Frame、调用生命周期或恢复资格，不提出新的公开 API。

## 1. 盘点口径

范围是 `services/conversation/src` 和 `services/observer/src` 的生产 TypeScript。使用 TypeScript AST 收集同时具有 `name/state/resume` 的 point 对象配置，再人工核对 `check` 回调及其所调用的业务 helper；以源码配置位置计数，不以运行实例或独立函数计数。排除 reception 值检查、输出契约、HTTP 恢复资格入口和数据库完整性检查。

| 服务         | 含 point 的文件 | point 配置位置 | 明确配置 check | 未配置 check |
| ------------ | --------------: | -------------: | -------------: | -----------: |
| conversation |              16 |             43 |             34 |            9 |
| observer     |              24 |             60 |             60 |            0 |
| 合计         |              40 |            103 |             94 |            9 |

ToolLoop 的三个点共用一个 `check` 函数，计为三个配置位置；Observer 的两个 `capability*.${name}` 模板位置会按装配能力展开，不把模板数当运行点数。各服务按条件选装 point，表中也不是某次实际运行的点数。

conversation 未配置作者 check 的九个位置分别在：`completion.ts` 1 个、`materials/maintenance.ts` 2 个、`memory/apply.ts` 2 个、`model/completion.ts` 2 个、`tools/model.ts` 2 个。这不等于没有校验：它们仍有 state/input/output codec、内核关系和持久格式检查，以及各自的资源恢复逻辑。

## 2. 当前调用路径：作者检查前已经有全量成本

热保存路径见 [InvocationCheckpoint](../../server/invocation/src/checkpoint/invocation.ts) 第 128–161 行：

```text
捕获全部直接关系
→ 编码 input/currentInput/state 与关系正文
→ 认证完整 image
→ 解码全部关系（含 reception.check）
→ 认证 refs
→ 作者 point.check(state, facts)
→ 复核当前调用资格、修订与提交状态
→ Store.save
```

冷恢复在同文件第 99–107 行读取并复核 head 后完整 decode、refs 核验、point.check，然后才安装恢复活动。`resume.run` 是其后的执行入口。正常业务没有安装 CP writer 时，`work.checkpoint` 不存在，作者保存点及其检查不执行；资源和普通业务门控不能只依赖这里。

Runtime 在 [binding/work.ts](../../server/runtime/src/binding/work.ts) 第 94–107 行把原作者检查接到机制上。存在作者 check 时，[savedCheckpointFacts](../../server/runtime/src/binding/checkpoint.ts) 第 8–26 行先为全部 N 条关系创建事实包装和 `byId` 索引：

| 操作                                    | 当前读取范围                                                              |
| --------------------------------------- | ------------------------------------------------------------------------- |
| 构造 saved facts                        | 每次 O(N)；所有关系包装与索引重建                                         |
| `get`、`require`、`accepted`、`handled` | 在本次已构造的索引中点查；`accepted/handled` 此处不再执行 reception.check |
| `values()`                              | 第 62 行，每次分配并枚举全部 N 项                                         |
| `list(definition)`                      | 第 56 行，每次扫描全部 N 项后过滤                                         |
| `requireUnique`                         | 调用 list；不是按声明预建的常量查询                                       |
| refs 投影                               | 第 64 行，按作者所选全部出现项逐项投影                                    |

因此，减少固定接纳值的重复 `reception.check`，不会自动消除 saved facts 构造、完整 Frame 编解码和作者枚举。不能把作者回调访问一次准确 ref 写成完整保存只访问一个孩子。

## 3. 按成立依据分类，而不是按函数名分类

| 类别                       | 典型断言                                                                            | 可以复用的前提                                                               |
| -------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 固定材料之间的历史关联     | 孩子的输入等于原准备结果；已接纳值与该子交付对应；模型正文按固定规则解释为某个结果  | 参与断言的全部材料、准确关系和解释契约均已固定且认证。不能仅凭其中一个值稳定 |
| 当前 point/state/refs 组合 | waiting 指向尚未返回的孩子；completed 对应已接纳；当前 cursor、选择、计数和阶段相符 | 新组合继续核对。没有新子事实也可能因 state、point 或 refs 变化而失效         |
| 当前外部条件与执行资格     | 当前资源权限、预算、实体版本、是否允许执行下一操作                                  | 在业务执行／资源边界核验，不能由仅在 CP 保存或恢复执行的 point.check 替代    |

内置 point 检查及已核对的 helper 没有直接发起资源 I/O 或读取当前时钟；其主要输入是保存材料、关系、Schema 和装配配置。但这不是“任意作者 point.check 都纯”的证明：

- [AcceptModelOutput](../../services/observer/src/conversation/node/model/accept.ts) 第 38–42 行会调用注入的 `this.contract.accept`。[ModelOutputContract](../../services/observer/src/conversation/model/contract.ts) 允许提供任意实现；类型没有证明其闭包纯度。
- ToolLoop `check` 会调用 `selectTool`，进而执行登记的 Zod Schema；[registration.ts](../../services/conversation/src/tools/registration.ts) 第 23、67–70 行明确要求纯输入策略，并核对解析不替换原参数，但运行期仍不能证明任意 refinement 不读取可变闭包。
- [snapshot.ts](../../server/runtime/src/binding/snapshot.ts) 第 92–100 行固定点配置并绑定 check receiver，没有冻结所有闭包或证明业务函数纯度。契约版本说明兼容依据，不是依赖检测器。

`reception.check` 可以通过明确约束收敛为固定值契约；不能把这一结论扩展为“所有 point.check 都只检查值，执行一次即可”。

## 4. 生产用法目录

下表覆盖上述 94 个配置位置；同文件中的复用 helper 与点一并归类。行号为本轮工作树位置。

| 位置                                                                                                                                                                                                                                                                                                              | 配置数 | 主要检查内容及范围                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----: | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| conversation [history/tools/nodes.ts](../../services/conversation/src/history/tools/nodes.ts) 34、43；[prepare.ts](../../services/conversation/src/history/tools/prepare.ts) 34                                                                                                                                   |      3 | 请求与保存结果的索引／分页／大小对应；遍历命中项或材料 entries。固定内容约束，成本随结果大小                                                          |
| conversation [hosting/tool-answer.ts](../../services/conversation/src/hosting/tool-answer.ts) 80、89、106；[tools/answer.ts](../../services/conversation/src/tools/answer.ts) 19、29                                                                                                                              |      5 | 空分配计划、所选集合、唯一 Loop 孩子与输入／最终值对应。重建请求、比较正文；关系数预设为 0/1                                                          |
| conversation [materials/answer.ts](../../services/conversation/src/materials/answer.ts) 19、29；[input.ts](../../services/conversation/src/materials/input.ts) 26                                                                                                                                                 |      3 | 准备材料对应正式 query；固定模型请求与子调用、结果对应；既有历史关联和 waiting/completed 当前组合同时存在                                             |
| conversation [memory/content.ts](../../services/conversation/src/memory/content.ts) 21、32、55、65                                                                                                                                                                                                                |      4 | inclusion 与 remember 的准确输入、顺序和阶段；关系数 1/2，旧 inclusion 仍被后续点读取                                                                 |
| conversation [memory/maintenance.ts](../../services/conversation/src/memory/maintenance.ts) 50、74、99、116                                                                                                                                                                                                       |      4 | 旧 proposal 的 accepted/handled 与 ready/skipped；原捕获 context；apply 的输入、顺序和阶段。`completed` refs 为空仍必须读旧事实                       |
| conversation [memory/proposal.ts](../../services/conversation/src/memory/proposal.ts) 72、82                                                                                                                                                                                                                      |      2 | 重建 `modelRequest`，重新解析模型提案并与保存 changes 比较；关系数为 1，但处理量随完整消息／记忆材料增长                                              |
| conversation [model/completion.ts](../../services/conversation/src/model/completion.ts) 80、123、133、144                                                                                                                                                                                                         |      4 | 固定交互引用、send/read 关系与输入／回复关联；不查询实时 Interaction 状态。关系数 0/1/2，正文比较可较大                                               |
| conversation [recovery/scene.ts](../../services/conversation/src/recovery/scene.ts) 54、72、84、95、104、121                                                                                                                                                                                                      |      6 | 正式输入依据，before→prepare→answer→after 链路及接纳消息来源；helper 多次读取旧准备结果。当前关系数最多 4                                             |
| conversation [tools/loop.ts](../../services/conversation/src/tools/loop.ts) 119、120、125；函数 143                                                                                                                                                                                                               |      3 | 所有模型前缀、当前工具 cursor、准确 refs 与接纳凭据；唯一同时有明显历史增长和选择变化的本服务共享检查，详见下一节                                     |
| observer [conversation.ts](../../services/observer/src/conversation/conversation.ts) 78–194；helper 457–535                                                                                                                                                                                                       |     10 | `checkProgress` 全量扫描 accepted 进度、最新 decision、回答来源、文件和保存凭据；维护与当前能力角色。上限来自业务 decision budget，不能当通用调用上限 |
| observer [decision/default.ts](../../services/observer/src/conversation/decision/default.ts) 29、47；[function.ts](../../services/observer/src/conversation/decision/function.ts) 16                                                                                                                              |      3 | 叶子或唯一 understanding 的结果及当前选择；固定 input/round 核验                                                                                      |
| observer group [answer/candidate.ts](../../services/observer/src/conversation/group/answer/candidate.ts) 31、42、53；[generate.ts](../../services/observer/src/conversation/group/answer/generate.ts) 69–107                                                                                                      |      9 | 固定模型／准备材料；候选 accepted 或失败 handled；重生成依据与本次阶段。JSON 解析和完整内容比较；Generate 当前最多两个候选，不是通用限制              |
| observer group [context/maintain.ts](../../services/observer/src/conversation/group/context/maintain.ts) 41、52、69；[prepare.ts](../../services/observer/src/conversation/group/context/prepare.ts) 37、49                                                                                                       |      5 | 维护决策、保存 material 与 phase；`checkInstalledDecision` 比较已保存的来源 basis 和成员，不读取当前 View。成员数组按大小扫描                         |
| observer group [document/process.ts](../../services/observer/src/conversation/group/document/process.ts) 41、52、64；[save.ts](../../services/observer/src/conversation/group/document/save.ts) 26；[preflight/check.ts](../../services/observer/src/conversation/group/preflight/check.ts) 26、37                |      6 | 文件请求、read→generation 的固定内容及当前阶段；不重新读取文件。小关系集合，文档正文比较可能大                                                        |
| observer group [history/select.ts](../../services/observer/src/conversation/group/history/select.ts) 56–91；[request/understand.ts](../../services/observer/src/conversation/group/request/understand.ts) 50–85；[memory/extract.ts](../../services/observer/src/conversation/group/memory/extract.ts) 54–57、103 |     12 | 请求→模型→接纳→落实的准确材料链；提取 helper 遍历至多四个直接孩子并重算提案解释；关系数量小不等于正文成本小                                           |
| observer group [model/request.ts](../../services/observer/src/conversation/group/model/request.ts) 37、56、78                                                                                                                                                                                                     |      3 | 直接反馈／pending 后跟随的选择、固定请求与交互引用；不从当前外部反馈替换历史结果                                                                      |
| observer node [context/assemble.ts](../../services/observer/src/conversation/node/context/assemble.ts) 26；files/check、create、read；memory/apply；model/accept、follow、invoke、prepare                                                                                                                         |     11 | 叶子无孩子、原输入／round、保存结果对应；`model/accept.ts:38` 重新执行声明的解析与输出接纳规则                                                        |
| observer [scene.ts](../../services/observer/src/conversation/scene.ts) 32                                                                                                                                                                                                                                         |      1 | 唯一直接 conversation 调用及准确 key                                                                                                                  |

内核已经完成的身份认证与业务自己检查的关系链要分开计费。诸如“输出 B 来自已接纳模型 A 的固定解释”不是单纯字段形状，不能只靠 reception.check 替代。

## 5. ToolLoop：历史内容固定，不等于当前选择固定

定义 N 为直接关系总数，M 为所选模型数，C 为当前回复的工具请求数，T 为某工具所选关系数。以下为源码读取范围分析，不是本轮运行耗时或 CPU 基准：

| 位置    | 现在的工作                                                                | 应区别的依据                                                        |
| ------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 144     | 对照目录、等待与预算                                                      | 固定调用输入和固定装配契约                                          |
| 146     | `values().length` 枚举 N；累计各 refs 长度                                | 当前选择完整性；不能因没有新关系而跳过 refs 变化                    |
| 148–156 | M 个模型分别 `slice(0,index)` 并 deep equal；总前缀项处理 O(M²)           | 模型输入固定，但比较对象是当前 `state.exchanges` 及模型 refs 的位置 |
| 161–167 | 最新模型、current、cursor；过滤当前回复的工具列表 O(C)                    | 当前组合，每次变化仍需检查                                          |
| 168–175 | 已处理工具逐个解析参数并 `.find` 所选 refs；最坏 O(C×T)，另有参数正文成本 | 真实孩子与模型 call 的历史关联，加上当前选择出现顺序                |
| 177–181 | active 指向当前 cursor 的准确孩子和输入                                   | 当前组合；不能仅凭孩子自身合法就通过                                |

第七轮已经证明：只检查新增事件会漏掉前缀替换、refs 重排、state/current/cursor 变化。可复用的是某个**完整固定依赖组合**的证明，不是“旧孩子通过过检查”这个粗粒度结论。此前的显式失效反例继续适用，无需重新提出一套独立机制。

另外两项要分开：

- [loop.ts](../../services/conversation/src/tools/loop.ts) 98 行限制模型次数 1..32；这只是预设预算，不证明通用 Invocation 的历史可以反复扫描。各回复仍能派发多个工具。
- `confirmExchanges`（248–277）在恢复执行中通过资源读取完整交换和凭据；它不是 point.check。这里的全量确认与热保存的重复校验不能混算。旧事实已认证也不能替代外部实体仍可按准确依据读取的证明。

## 6. 当前外部条件必须留在行动边界

例如 Memory 的历史提案是按捕获到的 basis 形成的。CP 可以证明“apply 孩子的输入正是原提案”；资源执行时是否仍接受该 basis，由 Memory 的条件更新负责。把后者放进 point.check 会造成：开启 CP 才检查、关闭 CP 就绕过，或恢复时用今天的实体状态否定昨天已成立的提案。

因此，“当前能否继续”需进一步区分：

1. **保存的当前组合有没有声明的续接含义**：point.check 的职责。
2. **将要执行的实际操作现在是否获准**：调用控制、业务逻辑与资源端点的职责。

本轮不要求所有资源提供版本、凭据或事务，也不让 point.check 承担全系统一致截面。已有材料可以合法固定；外部条件仍按实际选用的资源契约变化。

## 7. 本轮验收与下一最小验证

本轮只进行了源码、AST 数量及 helper 路径核对，没有运行新的 point 性能基准，不改生产。不能从上述计数推导检查次数或耗时比例。

与本轮稳定接纳证据实验连接时，最小验证应保留：

1. 同一旧接纳已认证，后续保存不再执行它的 reception.check，但新的 point/state 仍执行本次组合检查。
2. 没有新关系，只替换 state、point 或 refs，仍拒绝不一致；沿用第六轮和第七轮反例。
3. 作者明确查询一个旧接纳值时，只按查询范围计费；不得把这次必要读取算作内核重复重检，也不能宣称所有旧正文访问绝对为零。
4. 冷恢复重新建立材料与关系依据，运行完整作者检查；不能沿用原进程中的固定证明。
5. 实时资源拒绝在 CP 开／关两种路径保持，由行动边界实施，不移到保存点。

下一轮若继续缩小热保存范围，优先让实验的已固定事实与原有按需查询接在同一条保存链上，并分别统计机制适配、作者查询、正文访问。不要仅省掉 reception.check，就宣称完整 Frame 已是增量成本；也不要为性能强制改变 refs 选择、state 内容或调用寿命。
