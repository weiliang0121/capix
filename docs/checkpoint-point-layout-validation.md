# 恢复点切换与选择依据：第十三轮验证

> 历史设计／验证记录：下文版本、测量和“下一步”保留当轮语境，不是当前兼容承诺。现行接口见 [Checkpoint](checkpoints.md)、[增量引用选择](checkpoint-selection.md)；旧格式与数据库策略见[开发期兼容](development-compatibility.md)。文档脉络见[导航](README.md)。

2026-11-07。承接[按需事实查询验证](saved-facts-view-validation.md)。仍是隔离模型、真实声明检查对照和跨进程实验；没有迁移生产 Context／Relation、Frame v5、原引用契约或恢复资格，没有提交代码。

## 1. 先纠正上轮模型的一个范围错误

**槽位名、目标和 one/many 属于具体 point，不能固定成整个调用只有一种解释。** 当前生产已经支持这些形态，并不是为了新方案需要增加的自由度。

| 真实声明                        | 合法变化                                                                         | 上轮固定布局模型的问题                   |
| ------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------- |
| Observer RequestModel           | `followWaiting.follow` 为 one；`feedbackAccepted.follow` 为 many，也可以为空数组 | 同名槽位在调用内固定基数，不能表达       |
| Conversation ContentMaintenance | include-one → 空 refs → remember-one → 空 refs                                   | 旧槽位仍在所有者中，空布局会被当作缺声明 |
| Conversation Scene              | `child` 依次指向 maintain、prepare、answer，再回 maintain                        | 名字相同不意味着目标声明相同             |
| Observer Conversation           | 回到同一个 decision 点，用新 child.ref 作为 active                               | 不能复用这个点上次的查询快照或检查结果   |

源码依据：[RequestModel](../services/observer/src/conversation/group/model/request.ts)、[ContentMaintenance](../services/conversation/src/memory/content.ts)、[Scene 恢复声明](../services/conversation/src/recovery/scene.ts)、[Observer Conversation](../services/observer/src/conversation/conversation.ts)。绑定本来逐点核对名称与合法直接成员，不要求跨点槽位统一。

这轮没有让生产适应实验的限制，而是修正了实验的建模范围。

## 2. 区分三件事

```text
调用持有的事实与当前选择材料
  source A：准确成员 X 的一个孩子
  source B：准确成员 X 的有序出现项，可重复
  source C：准确成员 Y 的一个孩子
                 │
                 │ 当前 point 的固定投影
                 ▼
  P.follow → A     Q.follow → B     R.child → C     S.refs → {}
                 │
                 ▼
  每次执行当前 point.check(state, facts)
```

`source` 是隔离表示里的内部选择来源，不是新增资源、业务实体或公共作者概念。它仍由原 FactCall 持有，不建立第二份关系状态。来源的目标和基数固定；不同点的作者槽位可以映射到不同来源。两个点也可以明确使用同一个来源。

例如 one → many 要明确形成 `[原孩子引用]`，没有隐式把单值转换成数组。不同 point 不选择旧来源，也不意味着删除孩子、交付或接纳。

[point-facts.mjs](../examples/checkpoint-facts-study/point-facts.mjs) 使用同一个 SavedFacts 认证全部来源，再把当前 point 的别名投影给作者。生产仍是原 API；下列仅说明实验边界：

```js
const waiting = {
  name: 'waiting',
  version: 1,
  slots: { follow: 'single-selection' },
  check(state, facts) {
    /* 核对当前等待组合 */
  },
};
const received = {
  name: 'received',
  version: 1,
  slots: { follow: 'many-selection' },
  check(state, facts) {
    /* 核对当前接纳组合 */
  },
};

points.save(waiting, waitingState);
// 正常业务推进，并明确提供下一点的选择。
points.save(received, receivedState);
```

实验 `version` 用来验证固定绑定的兼容依据。真实声明对照取整个 checkpoint 声明的版本，**不主张给生产作者新增一个必须维护的 point.version**。

## 3. 哪些认证可以沿用

热认证的依据是：

> 同一个事实所有者 + 固定成员／选择来源登记 + 上次准确成功提交的 revision + 此后完整的 pending 变化。

没有新增每来源的独立生命周期，也没有缓存任意 point.check 的结果。

| 变化                                         | 处理                                                 |
| -------------------------------------------- | ---------------------------------------------------- |
| 只换 point，来源内容没有变化                 | 沿用关系／many 选择认证；执行新的 point.check        |
| 换作者槽位名，但仍明确使用同一来源           | 使用新投影，不重新认证全部旧出现项                   |
| 新增孩子／出现项                             | 认证新增身份和选择目标；旧正文不重读                 |
| 孩子 waiting → returned → accepted，选择不变 | 身份依据仍有效；当前查询重新反映关系状态，旧快照不变 |
| 在 Q 中修改 P 使用的来源，再返回 P           | P 读取当前选择，不能返回上次缓存的结果               |
| 修改 state，没有新增关系                     | 当前 point.check 照常执行，可拒绝                    |
| inactive one 没有值                          | 可以保存其他点；真正选用它的点必须提供值             |
| 空 refs 点                                   | 不暴露旧选择；仍认证新关系和全部来源变更             |
| 原始低层 save 消耗了变化列表                 | revision 不匹配，原证明不能直接沿用                  |
| 作者检查或提交回执失败                       | 不安装成功认证；回执不确定仍由原所有者阻止继续       |

选择数组保留顺序和重复出现项。删除一个出现项不删除另一个相同孩子，也不删除原关系。未被选择的关系、inactive 来源中的错误目标，仍必须在作者读取之前拒绝。

来源登记扫描、投影布局处理、当前 one 核对仍各自有成本。多个 point 共享认证依据，不等于整个保存无成本。

## 4. 冷恢复不借机扩大保存承诺

探索中暴露了一个必须主动约束的风险：实验日志物理上保留非当前点的选择来源。如果重启后自动让其他点继续使用它们，就会恢复原 Frame 未必保存的作者选择材料。

本轮采用的保守规则是：

1. 热进程可以正常保留已明确建立的选择，供业务之后切换点时使用。
2. 冷恢复只认可**最后一个 head 的布局明确选择的来源**。
3. 后续点需要原 head 未选择的来源时，必须显式重新提供完整选择；单次 append 不足以证明整份旧选择已被重新声明。
4. 再次崩溃后，依据重新取自最新 head，而不是此前所有点的来源并集。

实验 `replaceSelection(source, children)` 只为验证“明确重新提供”的边界，不是拟新增的公共 API。先核对完整新选择，再更新来源；many 替换需要处理旧出现项和新项，成本为 O(旧项 + 新项)，不冒充增量免费操作。

物理记录尚未退休，冷载入仍完整认证旧来源。**“不能隐式使用”不等于“数据已经删除”，也不等于历史量或内存有界。** 这轮没有设计清理策略，没有恢复局部草稿，也没有因存在事实就签发行动权限。

### 原 head 的资格必须先成立

持久实验 envelope 保存准确 point 名称／版本、alias→source→成员契约／基数的布局描述以及作者 state。恢复顺序为：

```text
读取并完整认证事实库
→ head 与所有者已认证的 digest／identity／revision 对齐
→ 同步解码、固定原 envelope
→ 核对原 point 和准确布局
→ 运行原 point.check
→ 安装本次恢复可用的选择范围
→ 才能经这个入口检查或保存下一点
```

不能提交另一份同 owner/revision 的伪 head，也不能先运行一个容易通过的新点来替代原点检查。布局中更换 alias、source、基数或目标，即使都指向合法材料，也会因与原保存依据不同而拒绝。

这里的 digest 将传入材料对齐到事实所有者已核验的 head，不是防止有权限重写数据库全部事实的安全签名。回调实现的语义变化仍需维护声明版本，布局描述不会自动证明任意函数兼容。

审查发现并修复了一处时序漏洞：自定义 decoder 在锁外运行，可以先推进同一个调用，再把旧材料交回验证。修正后，解码和固定处于所有者已有的同步检查锁中，验证回调后重新核对依据，再安装证明。热保存的作者 state 固定与显式选择重设也遵守同样的受控时机。复用现有 inspect 操作，没有增加另一套 action 状态机。

这仍是候选恢复入口的组织约束，不是对任意持有底层 FactCall 的代码建立安全隔离；生产迁移必须把相同顺序放在真正的恢复接缝中。

一个刻意保留的成本：verifySaved 运行原 check 时不安装“成功保存”的热基线，其后首次 save 会再认证一次关系／选择元数据。之后才在各点间共享基线。这不重编码旧事实；本轮没有为了省掉这一次认证，另行改变证明安装时机。

## 5. 真实声明与反例

[point-policy.mjs](../examples/checkpoint-facts-study/point-policy.mjs) 从公开服务出口构造声明，不导入私有源码。4 条路径共 15 个真实阶段：RequestModel pending 分支 3 点、direct 分支 2 点、ContentMaintenance 4 点、Scene 6 点。每个阶段直接运行原 point.check，并经独立事实库存储／冷载入再次检查原点。

热推进使用明确 create／accept 事件及作者 refs 选择，不通过比较全量快照推导变化。eager 对照只在夹具中构造；实验 1-based 关系身份通过固定 `orderOffset=-1` 投影为生产的 0-based order，底层准确身份没有重写。

21 项策略测试还包含：旧维护孩子被错误选为当前孩子、模型 follow 输入变化、重复 follow、已接纳状态冒充等待、回答接纳正文变化，以及返回同一点时新 active／旧 active 的区别。某些没有正式 reception 登记的生产接收，在夹具中使用受限 identity codec 材料；不据此证明生产接纳编码已迁移。

本轮不执行 Provider、资源副作用、原 resume 回调或宿主资格检查。**调用真实 point.check，不等于已经完成真实 Runner 恢复。**

## 6. 成本验证口径

同一模型固定小值，N 个孩子逐个建立并接纳；每步保存一个选中当前孩子的点，再保存空 refs 点。随后不改变事实，在两个有引用的点与空点之间再切换 30 次。

实际计数如下。新增阶段认证 N 条关系与 N 个 history 出现项；切换阶段不重新扫描它们，但每次仍运行当前点检查、处理布局和 state、提交 head。

| 原有孩子数 N | 切换次数／point.check | 旧关系认证／旧 many 认证 | 新事实编码 | 查询包装／正文取值 | one 认证／来源元数据检查 |
| -----------: | --------------------: | -----------------------: | ---------: | -----------------: | -----------------------: |
|           32 |                30／30 |                     0／0 |          0 |             20／60 |                  30／120 |
|          128 |                30／30 |                     0／0 |          0 |             20／60 |                  30／120 |
|          512 |                30／30 |                     0／0 |          0 |             20／60 |                  30／120 |
|        2,048 |                30／30 |                     0／0 |          0 |             20／60 |                  30／120 |

有引用的 20 次切换各构造一份当前 ChildFact、读取输入／返回／接纳三个稳定值；10 次空点没有查询包装。这些是指针取值次数，不是深遍历字节数。每组仍提交 30 次 head，累计逻辑 head 字节为 30,310／30,430／30,460／30,550 B，包含布局和 state；没有把元数据及无事实变更的提交成本归零。

```sh
node examples/checkpoint-facts-study/point-layout-cost-study.mjs NEW_OUTPUT_DIRECTORY
```

数据和源码校验保存在 `.capix/point-layout-20261107/counts-final/summary.json`。这是确定性工作量验证，不是生产耗时、吞吐或全链路 O(1) 成绩。作者全量枚举、大 state、首次正文固定／编码、日志保留和冷恢复仍分别有成本。

## 7. 范围与后续

这一轮支持收敛的规则是：**稳定事实归调用所有者；选择材料有准确依据；槽位解释归 point；当前组合每次检查；冷恢复的可用材料由最后保存截面确定。**

内部来源键和 envelope 是验证表示，不要求作者增加一套“来源管理”概念，也没有决定生产 Frame 格式。现行完整 progress、失败身份、waiting 子 head 资格、资源窗口和退出机制仍需在真实接缝中保留。

之后应整理这条候选保存链到真实 Context／Relation／恢复入口的接入设计，明确哪些依据直接由原所有者提供、哪些实验适配器可以移除。不能把实验中每个辅助类都搬成生产实体，也不能把新数据含义当作无需决策的优化。

## 8. 验证记录

新增 **75 项**：PointFacts 35、SavedFacts 增补 2、真实策略对照 21、跨进程 15、成本计数 2。全实验目录 **681/681 通过**；两个已有类型工程及相关文件格式检查通过。

15 项跨进程验证用临时 SQLite 和首进程 process.exit(73)，覆盖正常恢复、原点验证前拒绝新点、inactive 明确重供、空 head、第二次冷恢复重新收窄、版本／alias／source／基数／目标不匹配、伪造传入 head、解码重入，以及重新计算摘要后的错误 state/layout/point。拒绝不推进修订，不执行后续保存。

```sh
node --test examples/checkpoint-facts-study/*.test.mjs
pnpm exec tsc -p examples/checkpoint-facts-study/tsconfig.types.json
pnpm exec tsc -p examples/checkpoint-facts-study/tsconfig.author-types.json
```

本轮复用已有工作区构建，没有运行全仓 build/check；生产源码与本轮开始时的未提交 diff 逐字一致。类型工程是既有契约回归，不是新实验 API 的完整类型证明。最终日志、源码 hash 和核对结果见 `.capix/point-layout-20261107/verification.json`。

没有访问生产数据库、真实模型、其他项目配置，没有重启服务、发布或提交。
