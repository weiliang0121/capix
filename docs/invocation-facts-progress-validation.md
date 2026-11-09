# 调用事实、局部推进版本与活动：第八轮验证

> 历史设计／验证记录：下文版本、测量和“下一步”保留当轮语境，不是当前兼容承诺。现行接口见 [Checkpoint](checkpoints.md)、[增量引用选择](checkpoint-selection.md)；旧格式与数据库策略见[开发期兼容](development-compatibility.md)。文档脉络见[导航](README.md)。

2026-11-07。承接[真实 ToolLoop 策略对照](checkpoint-tool-policy-validation.md)，继续在 Invocation、显式恢复点、实体与资源的既有边界内建模。本轮只有隔离实验和报告；未迁移生产稳定值契约、Frame v5 或宿主恢复资格。

## 1. 这轮收窄的问题

第七轮留下两处值得收敛的接缝：历史检查的依赖变化越来越多；紧凑前缀实验额外拥有一个数据库。这些不自动证明 Invocation 无法恢复，也不意味着必须增加一个推进实体。

本轮分别验证：

1. 真实 Invocation 中，哪些状态变化宣称了什么事实，谁拥有它；不能把多个阶段压成一个 `finished`。
2. 已取得的推进材料能否成为调用自己的不可变局部版本，与当前 CP 一起保存，不建立独立生命周期。
3. 旧事实的检查证明能否绑定准确的固定依据；当前组合仍独立检查。
4. 子调用能否通过已有资源窗口读取父调用明确交接的材料，而不跨 owner 使用本地材料接口。

“调用是活的”不要求它的每个数据项都可变。候选表达是：**活调用协调活动；已经成立的内容不改写；推进改变的是当前选择和新事实。** 暂不要求业务所有局部变量都不可变，也不把整个 Context 改造成新的持久实体。

## 2. 真实调用不能只有一个终态字段

核对真实 Invocation、Execution、Relation 和 CP 捕获代码后，最重要的顺序是：

```text
正文给出候选
→ 排空已启动的接纳、关闭 Work
→ 等待真实子调用退出、复核健康
→ Context.complete，输出 complete，发布 InvocationFact.finished
→ 关闭剩余资源窗口
→ CP.finish
→ 父关系安装 returned
→ 父回调与 reception.check
→ 父关系安装 accepted / handled
→ 父层后续保存
```

这是主要成功路径；失败可以在中间转入退出处理。关闭、通知和持久回执不是业务正文的一部分，却可能阻止成功交付。

| 内容            | 所有者与成立边界                                | 不能据此推导什么                                            |
| --------------- | ----------------------------------------------- | ----------------------------------------------------------- |
| 输入依据        | 本次调用；候选固定时机应早于资源 capture/refine | 生产目前仍保留原引用；不能假称已实现隔离                    |
| 子创建／waiting | 父关系固定准确孩子身份、声明位置、order、key    | 不代表已经启动，亦不代表已有首个子 CP                       |
| 工作终态        | 子 Context 完成工作与健康检查                   | `finished` 不承诺 CP 成功或父层成功收到                     |
| 持久交付        | 子 CP `finish` 的实际提交                       | 提交成功不等于本进程收到有效回执                            |
| 父层 returned   | 父关系实际收到孩子的交付                        | 不能用孩子的 Context 或磁盘状态替代                         |
| receiving       | 父层固定接收契约、进入接收回调                  | 不代表接纳完成；旧 Promise 和权限窗口不可恢复               |
| accepted        | 父回调完成且接纳校验通过，先安装再通知          | 通知失败不回滚接纳；实体落实与 CP 仍非同一事务              |
| handled         | 父层完成对可处理失败的接收                      | 孩子的 returned 仍然是 failed                               |
| 接收失败        | 接纳成立前的回调、校验或 receiving 通知失败     | 不等于子执行失败；accepted/handled 通知失败不改写已成立接纳 |
| 根入口退出      | Runner 的真实交付和占用释放                     | 先前输出 completed 不保证整个入口最终成功                   |

特别需要容纳以下组合：

```text
孩子 workTerminal = succeeded
孩子 durableDelivery = succeeded
父关系 returned = failed（CP 提交后回执失败，受保护）
```

这些是不同主体、不同边界上的真实判断。不能采用“最后一个事件覆盖终态”，也不能仅因正文相同就合并其语义身份。内容可以复用同一稳定正文，断言仍须分别归属。

这也限定了前几轮 `FactCall.finish()` 的证明范围：它的简化终态足以验证事实行与 head 协议，**还不能直接映射为真实 Invocation 的全部退出事实**。需要补齐这种差别后，才能讨论完整 Frame 的替换。

[真实时序测试](../examples/checkpoint-facts-study/invocation-lifecycle.test.mjs)共 11 项，实际运行现有 Invocation／Runner：正常四个关系阶段与真实 Frame 逐项对照；failed→handled；接收回调失败；receiving 严格观察失败时回调执行 0 次；accepted 通知失败不回滚接纳；Work 关闭失败；CP 提交后回执失败；根 released 失败；未启动关系；原引用变更；输入不变检查。

原引用反例仍然存在：修改返回值和接纳值的原对象后，后续 CP 会记录修改后的内容；观察时复制的旧值没有随之改变。输入在第一次保存前也可被别名修改，第一次保存后修改则被 Store 的 `original input cannot change` 拒绝。实验没有插入稳定值，也没有把这些现状当成迁移已完成。

## 3. 普通观测不能充当完整事实来源

真实时序探针使用公开调用端口、准确关系对象和 Store 对照。观察事件用于核对发生顺序，Store 用于核对实际保存内容；没有反过来从 Frame 补字段后宣称“事件已能独立重建 Frame”。

现有出口的缺口明确如下：

- `attached` 不提供 order、声明 position、子输入和 CP contract。未启动孩子没有 `started`，不能靠它补输入。
- `receiving` 不提供 reception contract；接收失败事件也不总带完整的 failure 归属。
- 正常 `captured/saved` 只有点和镜像身份；恢复 `installed` 才带历史 Frame。
- 恢复不重放旧 `started/attached/accepted`。已保存的基线与新发生的活动必须分开。
- 观察可关闭、隔离或漏记；事件正文是同步借用值，生产仍可能持有可变别名。

因此，未来若接入增量事实，准确依据应来自**事实成立的内部接缝及已绑定声明**。普通 Recorder 或 Observation 不能成为运行正确性所依赖的事实数据库。本轮没有新增这种机制端口。

## 4. 推进材料可以归原调用，不必独立建库

[局部版本实验](../examples/checkpoint-facts-study/local-progress.mjs)直接复用原实验 `FactCall.capture/material/save` 和 `FactStore`：

```js
// 实验伪代码；不是新增 Work API。
const next = progress.append(previous, alreadyObtainedMaterial);

// 新材料节点、其他新事实和当前 head 在同一次 CP 事务中提交。
progress.save('processing', {
  prefix: next,
  current: { key: material.key, revision: material.revision },
  cursor: 0,
  active: null,
});
```

每个局部节点保存 owner、用途、前驱、当前项和数量；head 只选择一个准确 token。节点固定后，本身的前驱／数量／材料形状无需在每次保存时重新扫描；冷恢复重新核验。

这只是调用取得材料后的一种表示，**不声称局部材料等于外部实体当前内容，也不证明 exchange.closed 或接纳凭据**。

本轮刻意保留多个选择分支：`P₁→P₂` 和 `P₁→P₃` 可以同时存在，旧 P₁ 也可以再次被选择。选择旧值不等于回滚实体，不重放旧调用，不形成会话 fork。是否允许某个业务流程回选由当前 point 的规则决定，表示层不擅自要求唯一 tip。

关系、材料和选择也没有混在一起：同一孩子可以出现多次；移除一次选择不删除真实关系。没有把既有 many 语义改成 Set。

### 单独检查当前组合

局部节点有效，仅证明那份固定材料自身成立。每次保存仍核验：

```text
current 指向所选节点的准确项
cursor 位于当前 calls 范围内
active 与当前 cursor 指向的 call 一致
completed 必须消费完当前 calls，且没有 active
```

因此，没有新增关系、token 完全相同，只改 cursor、current、active 或 point，仍能被拒绝。合法的当前变化形成新的 head，不改变旧材料。

可以继续在函数内使用可变草稿；CP 固定的是本次正式提交的版本。不是每一次赋值都要保存，也不是把业务局部变量全面改写成事件。

### 事务与回执边界

实验覆盖新事实写入、事件写入、head 写前、head 写后四个事务内故障：新节点与 head 一起回滚。提交后回执丢失则读取实际新 head，旧 writer 保持 uncertain；过期 writer 的比较提交被拒绝。

这些是同进程故障注入及重新认证读取；不把它称为新增的断电保证。前几轮的硬退出测试仍保留。本轮合并的只是“局部前缀元数据与 CP”这一个边界，外部实体提交、Interaction 和 CP 仍然独立。

## 5. 计数结果与实际成本范围

可复现产物：`.capix/invocation-progress-validation-20261107/summary.json`。记录样本逐次数据及实验／生产来源指纹。不是 CPU 或服务器吞吐量基准。

| 指标                               | 32 次追加 | 128 次追加 |
| ---------------------------------- | --------: | ---------: |
| 新事实编码总数（包含首次输入）     |        33 |        129 |
| 旧事实重新编码                     |         0 |          0 |
| 新节点首次认证读取（append 阶段）  |        32 |        128 |
| Store 保存路径读取旧正文           |         0 |          0 |
| head 字节范围                      |   803–806 |    803–809 |
| 再次保存相同 token：事实读取／编码 |     0 / 0 |      0 / 0 |
| 再次保存相同 token：当前组合检查   |         1 |          1 |
| 显式展开完整所选材料               |     32 项 |     128 项 |
| 冷恢复读取事实                     |        33 |        129 |
| 冷恢复核验局部节点                 |        32 |        128 |

这里每个材料项和当前 calls 数量固定且很小；不能将 head 的大小外推为任意 state 都有界。证明表仍持有已读取节点，FactCall 仍持有本调用事实，Store 的事实总量仍增长。此次没有声称解决驻留内存、长期保留或冷恢复总量，也没有用强制分段替代这些问题。

关键收益是：**一个新推进版本不必再次处理所有旧材料。** 当前材料选择的语义保持明确；真正要组装完整请求时，再显式承担展开成本。

## 6. 检查证据应该证明准确组合

从第七轮的失效表进一步看，可以将部分历史检查表达为：

```js
verify({
  owner,
  statementAndPolicy,
  inputFact,
  selectedPrefixFact,
  selectedOccurrence,
});
```

证据证明这组固定依据的具体断言。后来选择不同前缀、另一同 key 子实例或另一个出现位置，是另一个组合，不能沿用旧证明。旧证明没有被改写，只是不证明新组合。

这不是“值不可变，所以 check 可缓存”。作者仍要明确断言依赖；任意闭包、当前外部状态、可变策略不在证明内。B 类当前组合每次检查，冷恢复从持久依据重新检查；摘要相同也不能代替 owner、契约与出现项身份。

调用局部节点的结构证明与整体 CP 可提交证明还要区分：节点自身正确，可在某个 head 组合失败后仍然正确；但整体检查失败不能安装“这个 head 已核验并保存”的凭据。提交结果不确定时不能继续当作已确认基线。

### 准确依据实验

[FixedModelEvidence](../examples/checkpoint-facts-study/fixed-evidence.mjs)明确实现一个“模型输入对应所选前缀”的业务断言。24 项测试覆盖准确身份、策略、出现位置、当前组合、保存确认和冷重建：

| 场景                  | 历史正文读取 | A 检查 | B 检查 |
| --------------------- | -----------: | -----: | -----: |
| 首次准确组合保存      |            4 |      1 |      1 |
| 同组合再次保存        |            0 |      0 |      1 |
| 同 key 的另一个子实例 |            4 |      1 |      1 |
| 新检查器／冷恢复      |            4 |      1 |      1 |

仅执行 check 不安装整体证据；A 通过但 B 失败、提交失败、丢失或伪造回执均不安装。证据只在当前检查器私有表内，安装须经过 FactCall 对准确回执的校验。

该实验仍通过 `referenceEntries` 枚举定位当前选择：两次保存扫描了 4 个出现项。它只证明**旧正文检查可复用且不放宽当前组合校验**，没有宣称整个 check 已经增量化。真实 ToolLoop 的全部 A/B 规则和局部前缀链也尚未合成一个检查器，不能把两个组件的成绩相加当作完整生产链路收益。

### 既有资源形式可以兑现交接

[资源接缝测试](../examples/checkpoint-facts-study/local-progress-resource.test.mjs)用真实 `@weiliang0121/capix-resources` 的 `register → bind → open → methods` 做了 5 项验证，调用与持久事实仍使用实验模型，没有运行完整 Runner：

```text
父调用捕获局部材料
→ 建立携带准确 token 的子输入与 waiting 关系
→ 父 CP 一起保存材料、关系及 head
→ 明确的资源供给固定父 owner、孩子身份和原输入
→ 当前窗口读取准确材料
→ 窗口关闭后拒绝读取
```

孩子的 `material(parentToken)` 直接拒绝；通过明确登记的资源才可访问。材料未保存、派发关系未保存、错误身份／token 或正文丢失均拒绝，不能退回读取活父调用的副本。父层新增材料不改变原来的子输入所选的前缀。

资源实现故意采用保守路径：先完整认证持久 owner，再展开指定前缀。父材料增加一项后，两次读取的冷认证量分别为 3、4 个事实，指定前缀仍只展开 1 项。**这证明资源接缝的表达力，不是推荐热路径每次做全量 restore。** 之后的按需加载和证明复用仍需单独建模；这里没有用跳过持久核验来制造常量开销。

## 7. 本轮收敛与下一处接缝

这轮不改变结构层级、不改变调用身份、不添加推进实体，也不要求调用提前结束。可以继续沿以下分工推进：

```text
本次调用：活动协调、当前选择与退出
固定事实：输入、交付、接纳、取得的局部材料
检查：固定依据的断言 + 当前组合规则
CP：持久化已经固定的事实及当前推进位置
资源：明确范围内取得材料与访问外部能力
```

尚未完成的是完整生产事实接入：现有简化 FactCall 缺少准确的工作终态／持久交付／父层 returned 区分，以及接收失败、受保护故障和绑定声明的完整字段。下一小步应把这些**已存在的实际语义**接入同一实验事实表示，逐项与真实 Frame 和恢复拒绝矩阵对照；不能先凭一次成功路径宣布 Frame v6 已成立。

原引用契约与稳定交付的正式修订、持久格式迁移、全仓作者适配仍待这条闭环证明后处理。普通观测缺字段不是这轮顺手扩充观测体系的理由。

## 8. 复现

本轮新增 **56 项测试**（真实时序 11、局部版本 16、资源接缝 5、准确依据 24），全目录 **367/367 通过**。日志：`.capix/invocation-progress-validation-20261107/tests.tap`。稳定值和作者契约两个 TypeScript 工程继续通过，保留原有 22 + 19 个编译负例。本轮格式检查与 `git diff --check` 通过。

测试基于当前已构建工作区及既有实验，不代表完成全仓生产迁移。工作区原有的 value／Store 缓存等未提交改动原样保留，本轮没有修改它们，也没有提交代码。

```sh
node --test examples/checkpoint-facts-study/*.test.mjs
pnpm exec tsc -p examples/checkpoint-facts-study/tsconfig.types.json
pnpm exec tsc -p examples/checkpoint-facts-study/tsconfig.author-types.json
node examples/checkpoint-facts-study/invocation-progress-study.mjs .capix/invocation-progress-new-run
```

计数目录必须不存在。全部材料为人工离线数据，不访问真实模型、凭证或生产数据库。
