# 调用事实固定：最小场景推演

状态：2026-11-06，独立实验，10 项检查通过。**未修改生产机制或现行“保持原引用”契约。** 本目录验证候选的数据含义与处理范围，不是新的公共 API、CP 格式或恢复实现。

后续：[第二轮交付边界与候选不变量](boundary-options.md)，新增 11 项，合计 21 项。两轮一起运行：`node --test examples/checkpoint-facts-study/scenarios.test.mjs examples/checkpoint-facts-study/boundaries.test.mjs`。

第三轮：[稳定交付值的契约小场景](stable-delivery.md)，补充消费者修改、真实三层调用、故障边界、值域往返与共享 DAG 成本反例。全部实验：`node --test examples/checkpoint-facts-study/*.test.mjs`。

第四轮：[契约与迁移验证报告](../../docs/stable-delivery-validation.md)，修正 DAG 固定算法并增加预算；以进程内模块加载探针自动插入真实调用边界，盘点全仓兼容性；增加真实 SQLite/子进程恢复切点。细节见 [算法](algorithm.md)、[回执与恢复](receipt-recovery.md)。`migration.test.mjs` 自行安装隔离探针，生产源码不变；`census.mjs --run 新目录` 可复现完整对照。独立类型验证：`pnpm exec tsc -p examples/checkpoint-facts-study/tsconfig.types.json`。

第五轮：[稳定事实与增量检查点](../../docs/stable-facts-head-validation.md)，逐节点摘要、独立 SQLite fact/head 协议模型、16 个硬退出切点、32–2048 子调用基准及实体版本缓存反例。新模型未替换生产 Frame，不把模型恢复测试等同于生产 Runner 迁移。规模实验：`node examples/checkpoint-facts-study/fact-benchmark.mjs --run 新输出目录`。

第六轮：[作者契约与检查范围](../../docs/checkpoint-author-contract-validation.md)，保留 many 的顺序和重复出现，增加增量选择与精确查询；三个业务形态、局部材料保存、9 个硬退出切点及 32–2048 子调用成本对照。不限制 state 只能有 cursor，不强制分段，不迁移生产。新增类型验证：`pnpm exec tsc -p examples/checkpoint-facts-study/tsconfig.author-types.json`；规模实验：`node examples/checkpoint-facts-study/author-benchmark.mjs --run 新输出目录`。第五轮成绩是当时源码快照；当前模型已增加选择索引，旧实验库不自动迁移。

第七轮：[真实 ToolLoop 策略对照](../../docs/checkpoint-tool-policy-validation.md)，直接调用生产声明的 check/恢复确认，与局部检查及多值 key 索引比较；独立前缀表示保留实体的自由顺序，并与实验 CP 做跨进程交接。未迁移生产，不强制封口；历史 token 的材料不依赖后续 tip。计数复现：`node examples/checkpoint-facts-study/tool-policy-study.mjs 新输出目录`，其中完整快照适配器的扫描单独记录，不当作增量运行实现。

第八轮：[调用事实与局部推进版本](../../docs/invocation-facts-progress-validation.md)，沿原 Invocation／CP 路线验证真实退出边界、随 CP 同事务保存的调用局部材料、准确固定依据与当前组合检查，以及明确的资源交接。新增 56 项，合计 367 项；不迁移生产，不增加推进实体或强制分段。计数复现：`node examples/checkpoint-facts-study/invocation-progress-study.mjs 新输出目录`。`invocation-lifecycle*` 观察现有真实调用；`local-progress*` 和 `fixed-evidence*` 使用实验事实模型，两者不混称完整 Frame 迁移。

第九轮：[真实生命周期与事实表示](../../docs/invocation-lifecycle-facts-validation.md)，将准确 Context／Relation 边界接入实验事实库，独立重建 v5 Frame 与真实保存比较，再经硬退出及真实公开恢复入口核对资格。区分工作终态、持久交付、父 returned，以及已保存 receiving 的活动重入；启动前取消可记录而不取得恢复资格。计数复现：`node examples/checkpoint-facts-study/lifecycle-study.mjs 新输出目录`。保留全量 v5 对照开销，不宣称生产保存已经增量化。

第十轮：[Action、局部草稿与资源承诺边界](../../docs/action-resource-boundaries-validation.md)，验证并发草稿、真实资源的冲突／部分效果／零内容变更、双库硬退出后的普通重入与准确确认。草稿不恢复，资源承诺不由 CP 生成；真实取消期间接纳仍可成立的现状单独记录，不改生产规则。无资源调用的 32／128／512 关系计数仍呈历史重复增长；增加草稿编辑或普通资源访问不改变 CP 捕获范围。计数复现：`node examples/checkpoint-facts-study/action-cost-study.mjs 新输出目录`。

第十一轮：[接纳固定契约与重复检查](../../docs/reception-contract-validation.md)，分别验证真实调用的“固定→检查→安装”、实验事实模型的首次持久认证与旧事实免重检、10 项新进程／硬退出反例，并盘点生产 point.check 的读取范围。取消收尾保持现状，不迁移生产原引用或 Frame；坏 codec、可变检查闭包及未升版本的解码漂移各自说明边界。计数复现：`node examples/checkpoint-facts-study/reception-cost-study.mjs 新输出目录`。

第十二轮：[固定事实、按需查询与当前组合](../../docs/saved-facts-view-validation.md)，在同一事实保存链中按需构造作者事实，独立认证 refs；接入真实 ToolLoop 的 13 个阶段与拒绝反例，计量作者全读和局部查询，跨进程先核对原 head 再继续。未迁移生产，未把懒查询变成延迟认证；查询窗口与不同 point 布局的兼容边界明确保留。计数复现：`node examples/checkpoint-facts-study/saved-facts-cost-study.mjs 新输出目录`。

第十三轮：[恢复点切换与选择依据](../../docs/checkpoint-point-layout-validation.md)，区分调用持有的选择材料与 point 的槽位解释，覆盖 one/many、空 refs、同名不同目标和返回旧点；实际服务 15 个阶段原 check 对照，30 次换点的规模计数与 15 项跨进程验证。冷恢复只认可最后 head 的选择范围，inactive 材料必须显式重供；不承诺草稿恢复，不迁移生产。计数复现：`node examples/checkpoint-facts-study/point-layout-cost-study.mjs 新输出目录`。

接入设计：[固定事实接入 Context／Relation](../../docs/checkpoint-facts-integration-design.md)。对照真实输入捕获、退出、接纳、点绑定和 Store，把实验职责归回现有对象；列出查询寿命、完整 save 返回值、聚合容量及作者检查基线的兼容性决定。仅设计与既有实验复跑，未增加生产迁移成绩，未更改原引用或 Frame v5。

后续独立议题：[显式恢复与协调重放对照](../../docs/recovery-replay-comparison.md)。使用同一事实与效果确认规则比较两种推进方式；实验在相邻 `recovery-comparison/` 中，不替换本目录模型，也不迁移生产。

从仓库根目录执行（使用已构建的工作区包）：

```sh
node --test examples/checkpoint-facts-study/scenarios.test.mjs
```

没有网络、模型、服务重启或生产库访问。跨进程实验在临时目录写入人工材料，结束即清理。现状探针使用公开 Invocation/MemoryCheckpointStore；候选使用本目录的可执行伪代码。两者不能混称为生产迁移测试。

## 与评审的对照

| 评审意见                                          | 核对结果                                                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 保持原引用与强制固定内容存在冲突                  | 成立。当前 Context、returned、accepted 保留原业务引用。新的隔离规则属于契约修改。                                                                       |
| CP 开关已导致两套正常调用数据含义                 | 需修正：当前两边都保留活引用，反例证明的是缺乏稳定交付，不是开关让一边固定、一边可变。CP 还会引入保存失败，这与交付内容含义不同。                       |
| B：作者承诺不改，成立时编码一次，后续发现修改拒绝 | 可以作为作者纪律，不能同时保证“事实保持原值”与“以后不扫描”。原别名一经修改，facts 已变化；检测只是之后拒绝。摘要/深比较仍要读取旧内容。                 |
| 摘要可检测原对象是否变化                          | 只对被编码的投影成立。codec 若忽略字段，运行对象已经变化但摘要仍相同。                                                                                  |
| A：复制或冻结                                     | 需要分开。复制隔离改变身份但不限制作者原对象；冻结原对象会改变作者写入行为；可信固定值可以直接复用。实验只验证“未知纯数据隔离 + 本地认可的固定值复用”。 |
| 成立时必须执行 CP codec                           | 不必。正式数据先固定，持久编码可以等首次保存。这样 CP 未开启时也有相同数据含义，不执行持久 codec。是否采用这一时机尚未定案。                            |
| O1 自然由孩子 finish 持久一次                     | 有条件。孩子没有首份 CP 时 finish 不写 head；现行父 CP 可保存无 CP 子调用的返回。逻辑所有者不等于物理持久载体。                                         |
| 失败事实需要固定                                  | 成立，但固定诊断不等于替换业务 Error。捕获身份、instanceof、故障归属需保留。                                                                            |
| 有固定值证据即可复用全部检查                      | 不成立。证据只能证明该值的固定性/受限形状；新的消费契约、状态组合、codec 往返语义仍各自检查。                                                           |

“不深度冻结闭包”与本议题并不直接冲突：闭包/配置/资源句柄不等同于正式交付数据。真正需要修订的是 IO 原引用与正式事实的关系。

## B 的反例

```js
const raw = { nested: { text: 'before' } };
const returned = { output: raw };
const encoded = structuredClone(raw);

raw.nested.text = 'after';

returned.output.nested.text; // after：正常消费者已经看到新内容
encoded.nested.text; // before：持久材料仍是旧内容
```

之后比较并拒绝，不能撤回此前基于 after 做出的处理。若保留任意原别名，Proxy 只约束经代理的写入，原对象与嵌套别名仍可绕过。

实验另外统计：成立时 codec 调用 1 次；随后 codec 调用 0 次，但验证函数仍 JSON 编码并扫描旧内容。**旧 codec 次数为零，不等于旧正文处理成本为零。**

B 在“作者严格不修改，否则行为不受保证”的前提下可以使用。它不是无价值方案，但不能当作内核隔离保证，也不满足本场景的误改反例。

## 候选的固定边界

| 内容           | 形成固定内容的时机                 | 后续变化                                           |
| -------------- | ---------------------------------- | -------------------------------------------------- |
| 父输入 I1      | 资源捕获/范围解算之前              | 调用结束前沿用同一内容；作者自己的输入草稿仍可修改 |
| 子正式返回 O1  | 完成对父交付的边界                 | 不能由原对象别名重写                               |
| 父正式接纳 A1  | 父接纳成立                         | 父层后续计算形成新值                               |
| 实体内容 M1/M2 | 实体校验并提交新的内容版本         | 实体当前指向推进，旧内容不变                       |
| 业务状态 S1/S2 | 本实验仍在各次保存时固定作者 state | 暂不推定作者所有局部变量都必须不可变               |
| 持久表示       | 首次需要保存固定事实时             | 同一事实在该固定 codec 下只编码一次；恢复重新验证  |

这里的“正式返回”不是正文函数刚 return。当前 Invocation 还要处理输出校验、后代退出、严格观察与关闭，之后才向父关系交付。实验的 publish 表达该边界，不模拟这些生命周期机制。

持久编码若改变含义，仍有正常/恢复分歧。例如 `decode(saved) => saved.trim()` 会丢失正常返回中的空格。实验有反例；未来需要决定语义往返规则，或者把有意规范化放在正式交付之前。本候选使用 identity 的纯数据 codec，不能据此证明任意现有 codec 都兼容。

## 一份父输入、两次子调用、一次实体更新、两次保存

实体使用真实 Transcript/Memories：先建立一条记忆，运行中更新一次。M1/M2 表示两份固定内容，实际集合 sequence 从 1 到 2，不假设存在历史版本数据库。

| 步骤 | 动作                                       | 断言                                              |
| ---- | ------------------------------------------ | ------------------------------------------------- |
| 1    | 固定父输入 I1，资源捕获/执行取得同一值     | 修改作者原输入草稿不改变 I1                       |
| 2    | 第一个孩子读取 Memory 当前内容 M1，形成 O1 | 原返回对象不再拥有 O1 内容                        |
| 3    | 父层转换并形成 A1                          | 修改原接纳对象不改变 A1                           |
| 4    | **第一次 CP 之前**修改原返回和接纳对象     | O1/A1 仍保持正式交付值                            |
| 5    | 保存 CP1：I1、O1、A1、S1                   | 三份事实各编码一次                                |
| 6    | 实体更新为 M2                              | 真实 Memory.snapshot 的旧 M1 仍稳定               |
| 7    | 第二个孩子显式读取当前 M2，形成 O2/A2      | 输入 I1 不变；旧 O1/A1 不变；新读取可以使用新内容 |
| 8    | 保存 CP2：沿用旧事实，增加 O2/A2、S2       | 旧三份事实不再编码；CP1 的 state/refs 仍不变      |
| 9    | 新进程从 JSON 文件加载                     | 重新检查格式、正文摘要、记录形状及引用可用性      |

候选运行结果：

```text
CP1 新编码：I1 O1 A1
CP2 新编码：O2 A2
最终编码次数：I1=1 O1=1 A1=1 O2=1 A2=1

开/关 CP：输入、第一次读取、第一次接纳、第二次读取的内容相同
原对象修改：不会改写正式事实
新进程：能读回 M1 与 M2；删除 O1 正文后明确拒绝
```

新进程检查还覆盖正文改变但摘要未变、codec 版本不兼容，以及修改字段类型并重新计算摘要。摘要只用于检测对应材料损坏，不是防恶意篡改的认证系统。

这个候选保存了旧正文，因此恢复 M1 不依赖实体当前的 M2。如果改成仅保存实体 ID/版本，必须另有保留旧正文与按版本读取的契约，实验没有实现它。

## 额外检查与尚未证明的范围

- **固定值共享**：同一 FixedData 实例认可的值直接复用，不重复遍历。外部任意 freeze 的对象不能冒充本地证明；新的接收契约照常校验。
- **证据范围**：实验没有公开 WeakSet 或跨包通行证。共享类型放在 contracts 不会自动建立可信运行期证据；跨包互认位置尚未设计。
- **失败**：固定 Error 的诊断值，同时保留原 Error 用于 catch。之后修改 Error 不改写旧诊断。本实验未迁移真实失败归属或关闭失败合成。
- **编码失败**：已成立事实保持原内容，新保存没有取代旧 head。只是编码前失败的模型，不是 SQLite 提交失败/回执不确定、生产重试许可或跨实体事务证明。
- **受限数据**：只支持普通 JSON 数据，拒绝 Date、Map、函数、类实例、访问器、循环；不把这个限制当作生产定案。无安全沙箱承诺。
- **语义范围**：候选未接入 Runner 的 Work、资源授权、实际父子关系认证、输出/失败/关闭机制，不宣称现有恢复矩阵通过。`captureInput = input` 只示意同一依据，没有验证实际 capture 链。候选只有 owner 字符串与 refs 存在性检查，未认证父子身份、成员位置及 point/state 组合；修改 owner 并重算摘要不会被它拒绝。只有 current.mjs 核对真实运行机制。
- **处理范围**：本实验第二次保存不遍历旧事实正文，但仍遍历 refs、固定 state、序列化 head。refs 从 3 增到 5；head 从 108 B 增到 119 B。它没有实现单步总成本有界。
- **恢复与存储**：StudyJournal 是内存中的表示模型，跨进程部分验证 JSON 重新校验；不是生产 CheckpointStore、崩溃恢复或事务实现。bundle 全量导出只用于实验传输，不计作增量保存。
- **实体粒度**：真实 View 更新仍构造完整成员数组/索引并保存成员状态；Transcript.snapshot 仍 slice 前缀；集合快照/来源材料捕获仍可能全量。值稳定不自动消除集合计算。
- **等待关系**：本实验只有已经成立的结果。现有 waiting 恢复读取准确子调用后来的 head/交付，不能因为固定事实引用而擅自改成全树固定 revision。

本轮支持继续推演的候选是：**正式交付先建立内容所有权；未知纯数据隔离一次、可信固定数据复用；持久编码与内容固定分开。** 它尚未解决富对象/能力引用、codec 语义、可选 CP 的全部兼容性和共享证据归属，不据此修改内核契约。

## 文件

- [current.mjs](current.mjs)：真实 Invocation/CP 现状探针。
- [model.mjs](model.mjs)：受限固定数据、事实与存储表示的可执行伪代码；类名只为实验阅读，不是公共概念提案。
- [scenarios.test.mjs](scenarios.test.mjs)：A/B 对照、实体变化、处理次数和失败边界。
- [restore.mjs](restore.mjs)：新进程读取已落文件并重新验证材料。

现状依据：[调用原引用](../../server/invocation/src/context/context.ts)、[接纳原引用](../../server/invocation/src/invocation/relation.ts)、[最终交付](../../server/invocation/src/invocation/invocation.ts)、[CP finish 条件](../../server/invocation/src/checkpoint/invocation.ts)、[Memory 固定内容](../../server/memory/src/memory.ts)。
