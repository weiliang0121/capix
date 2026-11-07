# CP 作者契约：引用选择、检查范围与局部材料

2026-11-07，第六轮独立实验。承接[稳定事实与增量检查点](stable-facts-head-validation.md)。本轮只修改 `examples/checkpoint-facts-study` 并增加报告；不迁移生产 Invocation、Frame、Work、服务声明或持久库，不修改现行“保持原引用”契约。

后续：[第七轮真实 ToolLoop 策略对照](checkpoint-tool-policy-validation.md) 已验证完整作者检查与实体确认的区别、显式失效的 A/B 检查、多值 key 查询及独立前缀表示。本报告的 206 项和规模数据保留为第六轮结果，不混入后续新增测试。

## 1. 本轮回答的问题

上一轮已证明，同 writer 已发布事实可以退出后续保存的重编码。本轮进一步验证：**作者仍能表达等待、选择、处理失败和保存局部材料，同时避免每次重新提交全部 refs 或由机制扫描全部历史。**

结论是在三个代表场景及规模模型中成立，但不能据此宣布生产 ToolLoop 已完成增量化。完整交换前缀、实体凭据和 `state.exchanges` 的增长仍需下一步按真实业务规则验证。

本轮没有引入强制封口、新调用身份、continue-as-new、历史退休或内存淘汰。计算范围、内存驻留、持久保留与调用生命周期继续分别讨论。

## 2. 先核对生产用法

完整证据见[作者契约盘点](../examples/checkpoint-facts-study/author-audit.md)。

| 用法                                                                     | 对候选设计的约束                                               |
| ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| ToolLoop 在 invoke 前保存子引用；同一声明反复调用                        | refs 必须容纳 waiting 与同声明不同实例，不能只派生“已接纳孩子” |
| 工具业务失败可以 handled；预检拒绝不创建孩子                             | 失败返回、父层处理、无子调用的业务推进不能合并                 |
| MemoryMaintenance completed 的 refs 可以为空，仍检查原 proposal 与 apply | 槽位是关注选择，完整关系仍是独立依据                           |
| MaterialPreparation 保存完整材料后恢复直接返回                           | state 不能被规定为仅有 cursor；来源变化后仍要拿回原内容        |
| 当前 many 是 readonly array，通用核验不禁止重复或作者排序                | 增量集合不能静默替换成去重 Set 或固定调用顺序                  |
| references 声明属于各 point                                              | 不得把点内同名别名理解成整个调用的同一槽位                     |

保留三层职责：机制认证真实关系和持久依据；作者选择恢复角色；业务检查 state、旧事实与实际实体效果之间的关联。

## 3. 引用的增量表示

实验保留单值角色，并为 many 使用有序出现项。一个 child 可以出现两次；移除准确的一次出现不影响另一次，也不删除关系或交付正文。

```js
// 实验接口，不是生产 Work API。
call.reference(activeSlot, child); // 选择当前角色，包括 waiting
const first = call.addReference(historySlot, child);
const another = call.addReference(historySlot, child, { before: first });
call.removeReference(historySlot, another); // 只移除一次出现
call.clearReference(activeSlot); // 完整关系仍能精确查询
```

内存使用按出现 ID 索引的邻接关系；SQLite 保存相应派生索引。追加、定点插入和删除只更新必要邻居及槽位元数据，保存不重写整个数组。`references()` / `referenceEntries()` 显式枚举时仍按成员数付费。`hasReference`、`referenceSize` 与准确关系查询不枚举历史。

持久槽位 key 在模型中表示**已经解算的槽位身份**，不是作者的字段拼写。测试把两个 point 的 `selected` 分别映射为两个 key，允许一个是 single、另一个是 many。有意共享才使用同一身份。真实绑定如何注册这些身份、如何与点契约一起版本化，仍未迁移；示例字符串命名不是强制 API。

新增选择事件与事实、关系、head 同事务提交。冷恢复重放事件并核验引用归属、准确身份、出现顺序、邻接项、成员数与派生索引。缺失、多余、错误顺序或篡改后重算摘要的错误身份均有拒绝测试。

出现 ID 由正常 API 使用 UUID 签发；模型没有新增移除后 ID 的永久拒重表。能够绕过 API 重写整段历史者不是这里的安全承诺。SQLite 索引查询仍有规模相关成本，固定点查次数不等于严格常数 CPU。

## 4. check 保持完整职责，查询范围可以明确

```js
// 每次保存仍执行 check。delta 用于定位新关系，不代替状态关联检查。
check(state, facts) {
  const changes = facts.changes();
  if (changes.mode === 'restored') verifyRequiredHistory(facts);
  else verifyNewRelationships(changes.events, facts);

  const selected = facts.referenceOf(activeSlot);
  verifyStateAgainstSelectedFact(state, selected, facts);
}
```

`changes()` 是按需读取的元数据批次，不携带重复正文；时间基线是**最后一次收到准确回执的 head revision**。check/编码失败不消耗变化；进入 Store 后发生故障或回执不确定，禁止继续保存，必须从持久状态重新进入。新进程明确标为 restored，不能把历史当作空增量跳过认证。

以下反例均拒绝：

- 没有新关系，但 state 从回答 X 改成 Y，与旧 accepted 内容不符。
- 没有新关系，恢复点从 waiting 换成 completed，孩子仍在 waiting。
- 选择另一个旧 accepted 孩子，但 state 仍对应原来的孩子。
- 记忆提案被 handled 为 skipped，却存在 apply 或其他未允许的子调用。
- 材料和 state 一起替换来源，虽然互相一致，却与固定调用输入不符。
- check 返回 Promise；保存和冷恢复都在继续之前拒绝，并消费迟到拒绝。

实验新增按准确声明位置/契约的 `relationCount`、`latestRelation`，以及直接关系总数。latest 按创建顺序定义，旧孩子后来更新不会成为最新创建的孩子。它们来自真实关系登记的索引，不能让作者“自报没有别的孩子”。全量 `allRelations` 仍保留，并明确计数。

**作者 check 并没有变成只看 delta。** 它仍可以读取必要的旧事实，也可以全量检查；模型不会自动推断业务函数的依赖或缓存任意 check。稳定内容只允许复用已成立的内容依据，新 state、新角色、新 point 的组合照常检查。

## 5. 必要局部材料可以离开反复编码的 head

```js
// 实验性表示：保存读取到的版本，不宣称调用已经成功返回。
const material = call.capture({ source: 'file-1', version: 7, text });
call.save('captured', { source: 'file-1', version: 7, material });

// 冷恢复先核验持久正文与作者点，再取原材料。
const original = resumed.material(state.material);
```

capture 固定局部材料，首次需要保存时编码一次；后续 head 引用它。读取检查本调用 owner 和 material kind，不能把输入或孩子交付 ID 冒充本层局部材料。原实体更新到版本 8，不改变版本 7；缺少已保存正文时拒绝，不回退到读取实体当前内容。

64 KiB 材料的第二次保存没有新增事实正文写入或重编码。该调用仍为 active、delivery 为 null；之后发生失败可以终结为 failed，不因为材料已经存在就制造成功交付。

这是表示能力验证，**不是要求所有作者手动增加 capture/material 两个概念**。未来可由声明好的局部材料槽位或明确的状态编码协作承接；必须先确定准确 codec、身份与类型关联。当前模型还没有这些完整绑定。state 仍可直接包含普通业务数据；增长过大有成本，不以性能为理由直接禁止其内容。

## 6. 三个场景与跨进程验证

| 场景          | 验证范围                                                                                       | 未冒充的范围                                               |
| ------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| ToolLoop 形态 | 同声明三次实例，accepted/handled/waiting 并存；准确 active；一次拒绝不产生孩子；恢复沿用原身份 | 没有完整复制生产的累计交换前缀、模型协议与外部反馈凭据核验 |
| 记忆维护形态  | 移除临时 refs 后仍查 handled；skipped 禁止额外孩子；ready 要求准确 accepted apply              | 没有实际提交 Memories 或 View，不证明跨实体事务            |
| 材料叶子      | 固定局部内容、来源关联、原实体变化、缺正文拒绝、后续失败不成功                                 | 不是实际资源窗口或生产完整退出链迁移                       |

新增 9 个硬退出用例：子进程直接退出，绕过 finally；新进程重新载入 SQLite。结果如下。

| 切点                                          | 恢复                        | 模拟外部效果次数 | 纯映射次数 |
| --------------------------------------------- | --------------------------- | ---------------: | ---------: |
| 父 waiting 已存、孩子无首份 CP                | 拒绝                        |                0 |          0 |
| 子局部材料已存、尚未 finish                   | 用原材料继续                |                1 |          1 |
| 子 finish 已存                                | 读取原交付继续              |                1 |          1 |
| 父接纳 facts/events/head 阶段退出，事务未提交 | 继续，映射重算              |                1 |          2 |
| 父接纳 committed 后退出                       | 继续，不重算                |                1 |          1 |
| 维护 completed 保存后退出                     | 无 refs 仍恢复 handled 依据 |                0 |          0 |
| 叶子 captured 后退出                          | 返回版本 7，不重读来源      |                0 |          0 |

叶子来源读取独立计数始终为 1。所有成功续接再次进入均为终态，不重复效果或映射。效果计数放在独立人工账本，恢复不查询该账本来猜测是否执行。原有 16 个 fact/head 硬退出切点也继续通过；这仍是协议模型，不能等同真实 Runner 采用新格式后的恢复验证。

## 7. 规模与负对照

每配置 3 个独立进程、新文件 SQLite（WAL/FULL）；N 为同一次调用内的直接子数量，输入 50 KiB、每个返回正文 64 B。每个孩子保存 waiting/accepted 两次。计时包围 save，含作者 check、delta 读取、新事实编码及 Store 提交；输入固定、create/returned/receive 时的首次固定在 save 之外，未计入此表，不能解释为完整运行耗时。

产物：[summary.json](../.capix/author-contract-study-20261107-final/summary.json)。每个 worker 记录并核对四个源文件指纹，开始到结束一致。较早 `author-contract-study-20261107` 为审查中试跑，不作为本报告依据。

|     N | 保存次数 | 累计 save 中位数 | 末约 10% 单次 p50 的中位数 | 最后 head |
| ----: | -------: | ---------------: | -------------------------: | --------: |
|    32 |       64 |         22.16 ms |                   0.284 ms |     501 B |
|   128 |      256 |         64.93 ms |                   0.198 ms |     505 B |
|   512 |    1,024 |        227.45 ms |                   0.182 ms |     506 B |
| 2,048 |    4,096 |        864.29 ms |                   0.178 ms |     509 B |

该配置下，普通保存的全量关系扫描、引用枚举、旧 SQLite 正文读取都为 0。事实编码总数为 `3N+1`，元数据事件为 `10N+1`。最后一份 accepted 保存仍是 2 份新事实、6 个事件、17 次元数据点读，与历史长度无关；首份保存另含输入发布。

最后无变化保存：新事实编码 0、事件 0；作者 check 仍执行，并主动点读最后一个孩子的 returned/accepted 两份旧值。**机制不处理无关旧正文，不等于禁止作者使用旧事实。** 这里计数的是值查询次数，不是深遍历字节数。

两个 N=128 负对照：

- 每次显式枚举完整 many：累计 16,640 次引用访问（含最后无变化检查），保存中位数 71.53 ms；平方项重新出现在作者所选的读取范围。
- 每次 state 内嵌累计历史 ID：最后 state 从 112 B 增为 2,972 B、head 从 505 B 增为 3,881 B，保存中位数 84.47 ms；事实编码数不变，增长转到 state/整 head。

小样本尾部时间下降受启动/JIT与计时噪声影响，不能理解为数据越多越快。计数与字节是本轮范围判断的主要依据。相较第五轮，新增有序选择和作者检查，工作量已经不同；不按两个毫秒数相除宣称优化比例。更不能将本模型与生产完整 CP 的基准直接相除。

## 8. 审查、验证与真实限制

本轮审查发现并补齐了：many 不能去重；点内别名不能全局固定形状；维护要核对全部孩子数量；材料要关联固定输入；异步 check 必须拒绝；局部材料需要 owner/kind 检查。反例进入测试。

最终全目录 **206/206 测试通过**，含新增 25 项选择/增量测试、19 项作者场景、2 项成本对照、9 项新硬退出测试，以及此前 151 项。日志位于 `.capix/author-contract-validation-20261107/tests.tap`。

两份独立 TypeScript 工程通过：原稳定值 22 个预期负例，新作者契约 19 个预期负例。新类型候选证明 single/many、准确成员 I/O、接纳值、槽位出现与局部材料的区别可表达；使用手工 unique symbol，不等于真实 Node 工厂可以自动推导独立名义身份。运行期身份和阶段仍须核验。

仍保留的限制：

- 冷恢复全量重建，FactCall 内存保留全部事实，事件日志不退休。没有新增常量总内存或常量冷恢复承诺。
- 热路径信任同一 Store 已提交的固定事实与索引；冷恢复重新检查，不把摘要当安全签名。
- 只处理实验里的关系字段，不是完整 Invocation 事实与故障归属。reception 仍使用实验契约，生产 reception.check 和宿主恢复资格未迁移。
- 新 refs 索引只用于本轮新实验库，不迁移旧实验库。生产数据库完全未动。
- 材料有 owner/kind 检查，尚无完整的逐槽位 codec 注册及真实声明绑定；类型实验与 JS 原型不是一套已完成的公共 API。
- 冷恢复会重新执行作者检查；热路径是否允许特定旧业务验证复用，取决于其明确不变量，不能从任意 check 函数自动推出。

## 9. 下一步仍在原议题内

下一步应选择生产 `ToolLoop.check` 这一条完整策略链，在隔离夹具中逐项对应：原材料、模型输入的交换前缀、反馈槽位、原始工具调用、精确接纳凭据，以及活动子调用。保持业务拒绝条件，对照完整检查与候选局部检查。

特别核对 `state.exchanges` 与多值引用之间哪些是同一事实的重复表达，哪些确实承载独立的业务选择；不能仅用“都是历史”就合并。先从完整策略中找不变量和增量依据，再决定局部材料、槽位和 check 的最终作者形态。

此项成立之后，才有足够依据对接完整 Invocation 字段与恢复资格。内存卸载、存储退休和调用封口分别保留，不因本实验能够连续执行 2,048 个孩子而提前决定，也不成为作者必须付出的结构成本。

## 10. 复现

```sh
node --test examples/checkpoint-facts-study/*.test.mjs
pnpm exec tsc -p examples/checkpoint-facts-study/tsconfig.types.json
pnpm exec tsc -p examples/checkpoint-facts-study/tsconfig.author-types.json
node examples/checkpoint-facts-study/author-benchmark.mjs --run .capix/author-contract-new-run
```

规模目录必须不存在，防止覆盖历史产物。普通测试使用临时人工库；不访问模型、配置或生产数据库，不重启服务。

实现入口：[作者场景](../examples/checkpoint-facts-study/author-scenarios.mjs)、[场景反例](../examples/checkpoint-facts-study/author-scenarios.test.mjs)、[引用与增量反例](../examples/checkpoint-facts-study/fact-selections.test.mjs)、[跨进程夹具](../examples/checkpoint-facts-study/author-process.mjs)、[规模实验](../examples/checkpoint-facts-study/author-benchmark.mjs)、[类型实验](../examples/checkpoint-facts-study/author-types.ts)。
