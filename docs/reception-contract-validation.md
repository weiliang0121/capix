# 接纳固定契约与重复检查：第十一轮验证

> 历史设计／验证记录：下文版本、测量和“下一步”保留当轮语境，不是当前兼容承诺。现行接口见 [Checkpoint](checkpoints.md)、[增量引用选择](checkpoint-selection.md)；旧格式与数据库策略见[开发期兼容](development-compatibility.md)。文档脉络见[导航](README.md)。

2026-11-07。承接[Action、局部草稿与资源承诺边界](action-resource-boundaries-validation.md)。本轮只新增隔离模型、真实调用边界探针、跨进程测试、源码盘点和报告。**没有修改生产 Context／Relation、Frame v5、原引用契约、取消收尾或恢复资格；没有提交代码。**

## 1. 结论与采用的实验契约

结果支持这个方向：**正式接纳在成立时固定并检查；持久表示首次形成时核验；后续保存不重新认证旧接纳；冷恢复重新建立依据。** 无需新增业务阶段、Action 实体、事务协调器或资源能力等级。

实验采用的契约是：

> reception.check 对同一稳定值、同一已绑定契约给出确定结果。可使用契约的固定 Schema 和配置；不得依赖可变外部条件、修改被检查的值或产生业务效果。检查同步完成，返回的副本不替换接纳值。

这是一条候选语义约束，不是任意 JavaScript 函数纯度的证明。绑定固定函数和 receiver，并不能冻结它们访问的所有闭包。生产原引用未迁移，不能仅补一句纯度声明就删掉现有热检查。

责任划分：

| 判断                                         | 所在位置                          | 本轮的处理                                     |
| -------------------------------------------- | --------------------------------- | ---------------------------------------------- |
| 当时是否接受结果、如何加工                   | 业务接纳回调                      | 可以读取业务资源；活动中使用私有草稿           |
| 正式接纳值是否符合固定契约                   | 固定后、安装 accepted／handled 前 | 与持久保存开关无关；失败不安装                 |
| 编码后能否准确还原正式值                     | 首次形成持久事实时                | encode → decode → 固定 → check，并比较语义往返 |
| 当前 point／state／refs 是否构成合法续接组合 | point.check 及内核关系认证        | 继续核验；不能因为没有新接纳就跳过             |
| 实际操作现在是否允许执行                     | 调用控制、业务逻辑、资源端点      | 按行动时机检查，不搬到可选 CP 中               |
| 磁盘材料是否可信且兼容                       | 冷恢复                            | 完整校验持久依据及解码值，不继承上一进程证明   |

本轮没有改变两条边界：不承诺草稿恢复；内核不自动承担资源的幂等、冲突或事务承诺。

## 2. 三条验证路径，不混称生产迁移

### 2.1 真实 Invocation 的成立边界

[reception-establishment.test.mjs](../examples/checkpoint-facts-study/reception-establishment.test.mjs) 使用公开 Invocation、Relation、资源窗口及 MemoryCheckpointStore。夹具显式在接纳回调交出候选后调用 StableValues.own，然后交给真实 reception.check／安装流程。

```text
业务回调形成候选
→ 夹具固定候选
→ 真实 check（关系仍是 receiving，没有 output）
→ 真实 accepted／handled 安装
→ 可选真实 Frame v5 保存
```

15 项验证覆盖：

- accepted／handled × CP 开／关：同一声明只切换保存端口，成立时始终检查固定值；子失败与父 handled 分开。
- 修改原草稿及嵌套别名，不影响已成立接纳；check 返回其他副本不替换正式值。
- check 抛出 undefined 仍是明确失败，不安装接纳；业务 catch 不能使已有受保护故障变成成功。
- 固定失败（函数、Proxy 抛 undefined）通过现有 invocation.reject 归属为受保护故障，祖先不能用 failed 接收吞掉。
- 普通业务回调失败保持原有可接收性，固定包装没有把所有业务错误都变成机制故障。
- 已进入接纳后取消：本地加工仍可完成接纳，父调用最终取消；访问受控资源则被拒绝，资源方法未执行。

固定和故障归属是**夹具显式接线**，不是生产自动插入。真实 v5 保存仍然重复执行 check。本组不能用来声称增量保存已接入真实 Invocation。

### 2.2 接纳证据与增量事实模型

[reception-evidence.mjs](../examples/checkpoint-facts-study/reception-evidence.mjs) 复用此前的 FactCall／FactStore／StableValues，不新增存储协议或并行生产状态。实验辅助层只负责接纳材料与准确契约的对应：

```text
稳定值 + 准确登记契约
    → 成立时 check
    → 既有关系安装 accepted／handled
    → 新接纳进入 pending 事实

首次保存 pending
    → 接纳 codec.encode
    → codec.decode、固定、check、往返等值
    → 原 FactStore 事务和准确回执核对
    → 安装已发布依据

后续保存
    → 仅处理新的 pending
    → 不进入旧接纳的 codec／check／正文
```

同一正文在两个孩子上仍是两份关系事实；同一稳定值在两个契约下仍分别检查。热路径按准确注册对象关联，冷恢复按固定描述及真实关系重新关联，不把任意同形对象或 Object.freeze 当证明。

27 项模型测试包含：异步 check 拒绝、固定和检查失败、契约替换／位置错误／结果种类不符、同值不同契约、无新事实但 point/state 检查拒绝，以及以下关键失败时机：

| 失败位置                    | 实验结果                                                       |
| --------------------------- | -------------------------------------------------------------- |
| 固定或成立时 check 失败     | 不安装 accepted／handled；模型停止后续写入                     |
| 首次 encode／decode 抛错    | 已成立接纳保持原值；没有持久认证、没有新 head                  |
| decode 得到不合法值         | 首次持久检查拒绝                                               |
| decode 得到另一个仍合法的值 | 首次语义往返比较拒绝；纯 check 不能代替这项验证                |
| Store 已提交但回执失败      | 不安装热发布证明；保持 uncertain，拒绝再次热保存；重读持久依据 |
| 无新事实但新的 state 不合法 | 当前 point 检查拒绝，旧 head 保持，旧接纳不重新检查            |

窄模型在成立失败时保留 receiving 并禁写，没有模拟生产完整 reception.failed 生命周期；真实失败归属由上一组 Invocation 探针覆盖。编码前故障后手动重试的单元反例只证明“失败未成为认证”，不赋予生产 Invocation 在 CP 故障后继续重试的资格。

### 2.3 新进程与硬退出

[reception-process.mjs](../examples/checkpoint-facts-study/reception-process.mjs) 和 [reception-recovery.test.mjs](../examples/checkpoint-facts-study/reception-recovery.test.mjs) 在独立临时 SQLite 中运行。首进程 process.exit(73) 绕过 finally，新进程重新创建稳定值和契约对象。

| 切点／反例                          | 新进程结果                                        |
| ----------------------------------- | ------------------------------------------------- |
| 接纳成立，尚未保存                  | 从最后 receiving 依据重新形成接纳；原草稿不恢复   |
| 新事务写 head 前硬退出              | 未提交事务回滚，仍从原 receiving 依据继续         |
| 新接纳已提交，回执前硬退出          | 读取已保存接纳；解码后 check 一次，接纳映射不重跑 |
| handled 已提交                      | 读取父处理值；保留孩子失败，处理映射不重跑        |
| 契约版本改变                        | 拒绝，不用旧进程的检查依据                        |
| 解码器产生不合法值                  | 冷检查拒绝                                        |
| check 隐藏的可变门槛改变            | 热保存不感知变化，冷检查拒绝；这是违约负对照      |
| 正文损坏、正文缺失、事实 owner 改变 | 拒绝，不公开恢复后的调用对象                      |

共 10 项。本组是**隔离 fact 协议**的接纳信任边界验证，不是新增生产恢复覆盖。完整生产 point.check、waiting 子 head 资格和取消终态等，仍由既有真实恢复矩阵负责；本轮全目录回归也复跑了这些用例。实验未运行外部副作用，不能从映射次数推出任意资源恰好执行一次。

## 3. 计算结果

对照使用相同孩子数量、固定小结果、父在每个孩子前后各保存一次。现状通过真实 Invocation／Frame v5 的 action-cost.mjs 计数；候选通过接纳证据层与已有增量事实模型计数。两条路径的功能范围不同，**这是确定性工作量对照，不是端到端耗时或吞吐成绩**。

| 指标                                |  N=32 |  N=128 |   N=512 |
| ----------------------------------- | ----: | -----: | ------: |
| 两条路径的主要父保存次数            |    64 |    256 |   1,024 |
| 真实 v5：父 save 内 reception.check | 1,024 | 16,384 | 262,144 |
| 其中检查前步骤旧接纳                |   992 | 16,256 | 261,632 |
| 候选：接纳成立时 check（另计）      |    32 |    128 |     512 |
| 候选：父 save 内首次持久 check      |    32 |    128 |     512 |
| 候选：父 save 内旧接纳 check        |     0 |      0 |       0 |
| 候选：接纳 encode／decode（各自）   |    32 |    128 |     512 |
| 候选 Store 热保存旧事实正文读取     |     0 |      0 |       0 |

N=128 的含义是：保存内 16,384 → 128，另有正常成立时 128 次。不能省略这 128 次，更不能说整个调用只检查了 128 次。冷恢复的检查单独付费。

每组另外保存一次相同 point/state、没有新增事实的 CP：接纳 encode／decode／check、旧事实正文读取和事实行写入均为 0；仍写入新 head、核对修订，Store 元数据读取为 2。无内容变化不等于省掉 CP 提交。

计数来自实际 check／codec 执行与 Store 读取；按保存标志区分成立时检查，不是由 N 公式填数。4 项计数回归核对 N=1/8/32，以及真实 v5 基线与候选的口径。

这里的收益依赖两项共同成立：固定契约允许复用旧接纳依据，已有事实模型让旧材料不再进入热保存工作集。**不是在现行全量 Frame 中加一个函数结果缓存就得到这些结果。** 当前 state 仍固定／编码，作者 check 仍执行，冷恢复仍全量读取；大 state、作者全量查询和内存保留仍是各自成本。

最终计数产物：`.capix/reception-contract-20261107/counts-final/summary.json`，包含实际样本及源码 SHA-256。之前的 `counts/` 是调整“额外保存使用相同 state”前的过程产物，报告采用 counts-final。

## 4. 不能由本轮承诺的两种函数行为

**check 读取可变门槛。** 原值通过并保存后，门槛变高，热保存不再检查旧事实；冷恢复会重新运行 check 并拒绝。因此不能承诺“违约也只是少执行一次，没有其他影响”。这不是需要增加自动纯度检测的理由，而是固定契约的适用边界。

**未升版本却改变 decoder 含义。** 单元负对照让同版本 decoder 把旧材料解成另一个仍满足 Schema 的值，冷恢复无法自动识别这种语义漂移。首次保存时有原稳定值可以比较；冷恢复只有那份持久表示，不能凭 Schema 推导作者原意。编码含义改变必须维护契约版本；本轮没有引入第二份原始真相、函数源码指纹或任意闭包证明。

## 5. 操作身份沿用已有接缝

[reception-provenance.test.mjs](../examples/checkpoint-facts-study/reception-provenance.test.mjs) 用真实 Invocation、并发接纳、ResourceBinding 和 ResourceEndpointActivity 验证既有路径：

```text
真实父子接纳活动
→ owner.reception()
→ activity.reception()
→ 资源加自己的 position
```

两个接纳跨 await 交错完成，均取得各自真实父子身份；接纳范围外拒绝取得该身份。普通资源访问不需要这个来源，未绑定 owner 时仍可普通读取。两项测试不建立新的操作身份系统，也不把身份等同于效果凭据或幂等性。

## 6. point.check 盘点与剩余计算范围

完整盘点见 [point-check-audit.md](../examples/checkpoint-facts-study/point-check-audit.md)。两服务共 103 个源码 point 配置位置，其中 94 处配置 check；是源码位置数，不是实际运行次数或唯一函数数。

关键结果：

1. 当前热保存仍全量捕获／解码；Runtime 的 savedCheckpointFacts 每次为全部关系创建包装和 byId 索引。之后点查虽快，前置全量成本仍在。
2. values/list/requireUnique 仍可能扫描全部关系。生产大量检查重建请求、比较旧输出／接纳或核对当前组合；关系少也可能反复处理大正文。
3. ToolLoop 的旧模型输入虽然固定，比较对象却可能是新的 state.exchanges 和新的 refs 位置。替换或重排仍会使旧关联证明失效，不能一概只检查新事件。
4. 未发现内置 point.check 直接访问资源／时钟；部分调用注入的业务 accept 或 Schema，不能因此证明任意配置纯。
5. point.check 检查保存组合，不替代 CP 关闭时也必须执行的资源行动门控。当前权限／配额／Memory basis 等按实际资源契约处理。

因此下一步应把**固定事实、按需事实查询、当前组合检查**接入同一条实验保存链，分别计量机制适配与作者读取。继续保留 state/point/refs 改变而没有新关系时的拒绝反例；不强制缩小合法 state、不改变 refs 的有序出现语义、不要求调用分段。

## 7. 验证与边界

新增 **58 项**：真实成立边界 15、证据模型 27、跨进程 10、计数 4、来源接缝 2。全实验目录 **513/513 通过**；workspace 构建、两个已有类型工程、格式检查通过。独立复核也复跑了模型、计数、冷恢复共 41 项。

```sh
pnpm build
node --test examples/checkpoint-facts-study/*.test.mjs
pnpm exec tsc -p examples/checkpoint-facts-study/tsconfig.types.json
pnpm exec tsc -p examples/checkpoint-facts-study/tsconfig.author-types.json
node examples/checkpoint-facts-study/reception-cost-study.mjs NEW_OUTPUT_DIRECTORY
```

`.capix/reception-contract-20261107/` 保存构建、测试、类型日志、计数与 verification.json。生产未提交 diff 与本轮开始时逐字比较；既有缓存候选、其他未提交工作均保留。

本轮没有网络／真实模型调用，没有服务重启、生产库访问或生产迁移。取消仍允许已进入的本地接纳收尾；持久终态不复活，但进程在终态保存前退出时，仍需按最后有效 CP 判断，不能以进程内取消状态替代持久事实。
