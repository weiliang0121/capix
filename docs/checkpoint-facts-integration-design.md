# 固定事实接入 Context／Relation：职责、时序与迁移边界

2026-11-07。承接[第十三轮验证](checkpoint-point-layout-validation.md)。用户已授权按本方案迁移。本文保留设计推导，实际实现与验证见[生产迁移报告](checkpoint-facts-migration.md)；第 8 节数字为迁移前实验记录。

| 本轮决定     | 落地约束                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| 稳定交付     | 沿用已讨论值域，在 input/returned/accepted/handled 各自成立边界固定；CP 开关不改变含义，原异常独立保留 |
| 普通调用预算 | 深度 64、展开值 1,000,000、展开文本 64 Mi UTF-16 单元；独立于逻辑 CP 8 MiB                             |
| 查询寿命     | 仅同步 point.check 内有效，已取得的固定值可以保留；thenable 拒绝                                       |
| 作者检查     | 每次执行 point.check；本轮没有按 point 维护的作者增量基线，不自动推断检查依赖                          |
| refs/state   | 继续显式完整提交，成本按实际大小计；不增加 many 操作 API，不禁止大 state                               |
| 持久表示     | Frame v6 增量提交、完整冷读取；Conversation SQLite v7；v5 可读但不续接执行                             |
| 保留         | 当前关系投影与当前 head 引用的正文保留，无引用正文释放，身份依据保留；不强制分段                       |

## 1. 这一步收敛的结果

**Context／Relation 持有已经成立的固定内容；Invocation 继续协调活动；CP 只提交本次选定的事实截面。** 不需要另一套调用状态，也不需要每次变化都复制整个 Context。

```text
业务输入／返回候选／接纳候选
          │ 在各自成立边界固定内容
          ▼
Context、Relation 中的固定值与状态指向
          │ 原对象维护自己的变化与派生索引
          ▼
InvocationCheckpoint
  选择当前截面 → 认证新增事实 → 检查当前 point/state/refs
          │
          ▼
Store：新增正文、关系／选择变化、head 同事务提交
          │ 准确回执
          ▼
安装持久发布依据；既有业务事实不重新成立
```

这里有三个不同的身份，不能互相替代：

- **稳定值**说明内容不会被原草稿别名改写，不说明谁返回或接纳了它。
- **调用事实**说明哪个 Context／Relation 在什么边界成立了什么；相同正文可以属于不同事实。
- **持久引用**说明某个事实按准确契约已有可核对的保存材料；有稳定值不等于已有持久引用。

摘要不能充当调用身份；`Object.isFrozen` 不能充当稳定值证据；一次保存成功也不能代替实体效果确认。

## 2. 实验职责归回哪里

| 现有归属                  | 应直接持有或完成的职责                                                        | 不应带进来的实验形状                              |
| ------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------- |
| Runtime 调用构造          | 在 validate/capture/refine 消费输入之前固定同一份输入；核验构造归属           | 第二个输入持有者、按 kind 划分的捕获生命周期      |
| InvocationContext         | 固定输入、正文结果与工作终态；状态更新替换小的只读记录，正文复用              | FactCall 的第二份 running/terminal 状态           |
| InvocationExecution       | 取得返回候选后及时隔离；沿原路径封口、排空接纳、关闭 Work、校验输出           | 把“内容固定”当作“成功交付”                        |
| InvocationRelation        | 准确 returned、receiving、accepted/handled、接收失败及契约归属                | ReceptionEvidenceCall 的平行接收状态              |
| InvocationChildren        | 完整直接关系、准确身份/顺序及查询索引；登记变更                               | 从 Observation 重建关系，或只留下 refs 选中的孩子 |
| InvocationCheckpoint      | 发布哪些事实、准确成功提交基线、待提交变化、保存排他、uncertain、恢复资格衔接 | 另起可运行的 FactCall；用存储 active 字段指挥调用 |
| Runtime 的 Work/CP 绑定   | point 身份和布局、成员/接纳契约映射、事实查询投影、恢复行动权限               | 公共 PointFacts、公共 source 注册表               |
| Checkpoint 包与宿主 Store | 持久事实/引用/提交协议及核验；同步原子提交与冷读取                            | 业务选择、资源幂等、调用调度                      |

实验 `StableValues` 所验证的纯值固定能力可以下沉为无宿主依赖的共同实现；实验 `FactStore` 只提供存储协议证据。其他辅助类应拆回上表，不按类的数量拆出生产对象。

共同固定实现可考虑放在 contracts 的窄纯值出口：只提供验证并隔离未知数据、复用本实现的可信产物，不公开“把任意对象登记为可信”的入口。实体生产者也使用同一实现后，快照穿过多个调用边界才可直接复用。已有深冻结但未经该实现形成的值，首次仍需核验。证据不跨序列化、不证明 codec 纯度，也不包含 CP 的 8 MiB 配额。

## 3. 固定发生在什么时刻

候选沿用已验证的数据域：普通记录、稠密数组、undefined/null、boolean/string、有限 number，保留缺失字段与 undefined、-0 与 +0 的区别。Date、Map、Error、函数、能力对象等不静默转换为交付数据；业务可明确形成数据表示。原异常传播另行保留。类型深只读不是运行期证明，Proxy 元操作也不保证无副作用。

这一范围及内容预算是正式迁移需要明确修订的条款；现有 Date codec、Error-as-input 等测试不能用“有 codec 就可绕过稳定边界”继续通过。恢复保持值的含义，不承诺重建 JS 对象身份或共享拓扑。

### 3.1 输入：不能只改 Context 构造器

真实顺序是：

```text
construction/calls.construct
  → scope.prepare
    → hooks.validate
    → ResourceInstallation.open / capture
  → CallableInvocationBuilder.create
    → supply.select / refine
    → new CallableContext(input)
```

依据：[调用构造](../server/runtime/src/construction/calls.ts)、[调用接线](../server/runtime/src/binding/calls.ts)、[Builder](../server/runtime/src/construction/invocation.ts)。若只在最后构造 Context 时复制，资源已读过另一份可能变化的输入。

候选伪代码，名称仅说明接缝：

```ts
function construct(structure, suppliedInput, scope, controls) {
  checkConstructionPermission();
  const input = fixInvocationInput(suppliedInput); // 早于所有消费该输入的宿主回调
  const prepared = scope.prepare(structure, input, controls);
  checkConstructionPermission(); // 回调可能取消、关闭或重入
  return builder.create(input, prepared); // refine、Context 使用同一份值
}

class InvocationContext {
  constructor(input) {
    this.input = fixInvocationInput(input); // 低层直接构造也受约束；可信值不重遍历
  }
}
```

固定失败发生在供给捕获和孩子建立之前，不创建伪 child 事实。取消、占用释放和父层机制故障仍走既有构造路径。Runner options、资源 origin、signal、Work 和业务闭包不属于这份输入，不做一锅式深冻结。

### 3.2 返回：候选固定早，正式交付仍晚

[Execution](../server/invocation/src/invocation/execution.ts) 当前先取得正文结果，再排空接纳、关闭 Work，之后发布正文返回和检查输出。候选必须在内核取得它的 await continuation 中、清理可能触碰原别名之前固定。

```text
业务 await 完成
→ 隔离成功候选；固定失败转换为受保护的正文失败
→ 输出封口、排空已进入接纳、Work.close
→ 正文结果记录、输出契约检查
→ 等已启动孩子退出、核对权威故障
→ Context 工作终态
→ 剩余资源窗口关闭
→ CP.finish（若本调用存在可终结的已保存 head）
→ 父 Relation.returnedWith／根入口交付
```

不是在每个箭头重新复制候选。后续边界复用同一固定值，但分别决定自己的状态能否成立。[Invocation.finishDelivery](../server/invocation/src/invocation/invocation.ts) 的成功顺序仍是 finish 后才向父关系交付。

固定失败、输出校验失败、取消、必要关闭失败均能阻止最终成功。不能为了插入固定函数跳过清理；也不能新增一个 await，让候选在隔离之前又暴露一个可变时间窗口。原资源方法的原始返回不因此一律提前固定，正式调用交付边界与资源操作契约仍分开。

### 3.3 接纳：在原 Relation 中闭合

[Relation.receiveWithinParent](../server/invocation/src/invocation/relation.ts) 已经有唯一接收路径，accepted 和 handled 共用它。

```ts
async function receiveWithinParent(delivered, callback, contract) {
  // 仍在既有 owner.receive 的真实父子接纳范围中。
  const draft = await callback(delivered);
  const value = fixReceptionValue(draft); // 固定失败为受保护故障
  contract?.check(value); // 同步、固定契约，返回副本不替换 value
  return value;
}

// 原 Relation 随后安装 accepted 或 handled，再发布通知。
// 通知失败保留已成立值，不倒退成 receiving 或再次接收。
```

`reception.check` 只依赖稳定值和固定绑定配置；业务资源条件仍由接纳回调及实际资源操作判断。首次持久化另做 encode/decode/固定/check/语义往返，冷恢复再检查解码材料。后续热保存不重跑旧接纳检查。

这里**不增加回调返回后的 blanket requireActive**。现状允许已经进入的纯计算接纳在父取消后完成，父调用仍按自己的终态失败；取消后的资源操作照常被端点拒绝。数据固定不借机改变取消收尾。

### 3.4 失败、并发与零变更

- 原始异常继续服务于 catch、instanceof、传播来源和 cause；正式失败诊断单独固定。后续补充清理错误可以形成新的失败归属记录，不原地改写旧诊断，也不把原 Error 交给纯值复制器。
- Relation 进入 receiving 后，回调持有自己的局部草稿；草稿不恢复。冷恢复可按已保存的同一契约重新进入活动，不再次宣称首次 receiving，也不承诺回调里的资源效果可重做。
- 固定、状态安装和截面选择需要同 owner 的短同步保护。保护不能跨业务 await，不能锁住整棵树；并行孩子和交错接纳继续有效。Proxy、codec、check、观察回调造成的同步重入必须拒绝或在提交前发现依据变化。
- 零正文变化仍可能是新的正式调用事实或新的选择。例如两次相同输出属于两个孩子；重复保存也可以有新 point/state/refs 和 revision。不能靠 deepEqual 正文省略这些变化。

## 4. 热保存消费同一份依据

生产当前每次执行 `captureCheckpointChildren → 输入/状态编码 → cloneCheckpointImage → decodeCheckpointFrame → refs 校验 → point.check`，见 [InvocationCheckpoint.writer](../server/invocation/src/checkpoint/invocation.ts)。目标是替换前面的全历史处理，保留最后的当前组合责任。

候选内部流程：

```ts
save(point, authorState, authorRefs) {
  return withinSynchronousSaveCut(() => {
    requireCurrentWindowAndHealthyOwner();
    const cut = selectOwnerFactsAndPoint(point, authorState, authorRefs);

    // 未发布事实按准确 owner/角色/契约首次编码；已有正文只引用。
    const fresh = encodeAndAuthenticateNewFacts(cut);
    authenticateRelationAndSelectionChanges(cut);
    const checkedState = encodeDecodeAndFixPointState(cut);
    runSynchronousPointCheck(point, checkedState, factsAt(cut));

    requireSameCutAndCurrentPermission(cut);
    markCommitUncertain();
    const receipt = store.commit(newFactsAndHead(cut, fresh));
    checkExactReceipt(receipt, cut);
    installPublicationBasis(receipt, cut); // 此刻才确认哪些变化已保存
  });
}
```

这些是职责伪代码，不是拟新增的一串公共 helper。提交仍同步；必要回调后复核 owner、revision、事实截面和访问资格。保存前的固定/解码/布局处理也在保护范围内，不能让 decoder 推进调用后拿旧 head 冒充新依据。第十三轮已有对应反例。

### 原对象提供增量，CP 不做全量 diff

Context／Children／Relation 在真正安装新事实时，使 CP 能得到新事实或关系变更的准确引用。可以是私有同步端口或 owner 内部的有序变更记录；不能依赖可关闭、可隔离、字段不完整的 Observation。

CP 的已发布映射只记录“这份事实在这个固定契约下已有哪份持久表示”，不再保存一个可以独立推进的 relation.status。CP 关闭时仍固定正式值，但无需执行持久 codec 或维持持久提交账本。对无 CP 调用，固定数据含义与普通调用一致。

同一值在两个事实、两个 codec 下出现，不能仅凭对象相同复用认证。首次形成持久表示也不能默认 codec 是纯函数：契约是**这份事实第一次成功形成的表示之后被引用**，不是允许无限调用 codec 却缓存任意函数结果。含义改变须维护版本；冷恢复不能检测同版本 decoder 任意语义漂移。

未选关系也要认证。完整关系索引、order/nextChildOrder、成员位置、返回和接纳归属不因作者不查询而跳过。查询按需只是少构造无关包装，不是延迟发现伪造事实。

### 事实归属不强迫子调用自己持久化

生产允许无子 CP 的孩子已经返回后由父 CP 保存其交付和接纳；只有等待续接才需要准确子 CP。因而：

1. 孩子工作结果、父实际收到的 returned、父 accepted 是不同归属。
2. 父提交可以首次保存它所需的稳定交付材料，不能只留下一个不存在的 child finish 引用。
3. 孩子已有持久成功时，可研究准确引用，但必须核对实际交付与契约；不是按 contextId 自动合并。
4. 孩子完成、父收到失败、父持久终态可能不一致，表示必须容纳它们。

尤其是“孩子 finish 已提交、回执失败”：持久成功不回滚；父收到受保护失败。父若已保存失败终态则不可恢复；父若在终结前硬退出、最后仍是 waiting，现行机制可能读取孩子的准确持久成功继续。这一行为已由[第九轮真实恢复矩阵](invocation-lifecycle-facts-validation.md)证明，应保留，不能一律改成拒绝或一律改成成功。

## 5. 作者 point、refs 和查询的接入

最小作者形状仍然是：

```ts
work.checkpoint({ point: waiting, state, refs: { child: child.ref } });
```

point 决定别名、one/many 和合法成员，Invocation 决定真实关系。不同点同名槽位可有不同目标/基数；空 refs 不删除关系；返回同一点要看这次明确选择，不能偷偷恢复上次选择。

### 完整数组和增量选择要诚实区分

现有 `refs: { models: [...models, child.ref] }` 每次重新给出完整数组，真实适配仍须处理这份完整申请。只读类型、同一数组身份或后台扫描 diff 都不能证明变化量。

大 many 的可选候选是：仍在同一个 refs 位置接收由本调用签发的**有序选择值**，追加/定点移除产生可认证变化，保留重复出现。普通数组照常可用，按完整长度付费。选择不是新子调用，也不是资源；不能成为绕过 point 布局和恢复行动授权的入口。

本轮将此能力推迟，**不增加 `work` 方法，不照搬实验 source key**。未来若引入，类型仍须证明准确成员、父归属、one/many、出现项移除和跨兼容 point 复用；冷恢复只自动供给最后 head 选中的材料。未选中的关系仍是真实历史，作者可以明确查询并重新选择。

普通 state 仍可保存完整材料；大 state 不能通过文档禁掉。未变化材料的显式固定引用可以避免反复编码，但实验 capture/material 的公开写法及逐槽 codec 绑定尚未定稿。以当前 state codec 重交整份材料时，就应计入这次成本。

### point.check 每次执行，不能借机制证明跳过业务断言

固定关系及选择身份的认证可以共享；不同点的业务断言不能共享。即使两个点使用同一个 check 函数对象，state、布局或选中的旧孩子也可能不同。

变化视图若开放，只能说明哪个准确成功基线之后发生了什么；它不证明“另一个点已经检查过我的历史”。作者划分历史断言/当前组合时，必须覆盖首次使用、冷恢复、选择替换、point 变化及其他实际依赖变化。没有这样的依据，就继续完整检查。不能让通用 adapter 自动只传 delta，也不能自动缓存任意 check。

首次迁移只有内核已提交事实的认证基线，不提供作者按 point 维护的增量基线。`point.check` 每次对自己实际读取的内容承担完整核验责任；按需读取避免提前物化无关事实，不能自动省略作者断言。将来开放变化视图时，仍须另行证明 point、布局、选择和冷恢复的覆盖关系。

迁移补齐运行期同步检查：拒绝 `point.check` 返回 thenable，并消费迟到拒绝。不能在异步检查尚未结束时提交。

### 查询寿命是实际的兼容性选择

当前 [savedCheckpointFacts](../server/runtime/src/binding/checkpoint.ts) 构造完整独立快照，查询闭包没有结束窗口。实验 SavedFacts 则在 check 后撤销查询，只允许已取出的固定 ChildFact 长期保留。

| 选择                                            | 收益                                                                | 代价                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 查询端口只在同步 check 内有效，已取得值保持稳定 | 可直接使用受保护的现有 owner 索引，避免整历史快照；不必保留查询版本 | 收窄现有可观察行为，必须写进契约、类型说明和迁移测试                                           |
| 查询对象本身长期表示这个保存截面                | 保留现有快照直觉和逸出查询行为                                      | 需要版本化索引/结构共享，或按需建立独立快照；不能把活 Map 留给旧查询，也不能隐藏首次 O(N) 成本 |

本轮选择第一种并迁移公开契约；保留两种方案的比较作为取舍依据。旧查询不能在下一次保存时重新开放，已经取得的固定值不随关闭失效。

## 6. 持久格式与恢复：先保留承诺，再定表示

候选 Store 必须将以下内容作为一个提交单元：新增固定正文、当前关系/选择的变化、当前 point/state 的依据、owner 的 head 和 revision。回执覆盖本次提交的准确身份与内容依据；进入 Store 后发生错误或回执不符仍按 uncertain 停止热推进，不能用“没有收到回执”推断未提交。

实验只追加事件链证明了这种提交可行，但**不要求生产永远保存每个中间状态事件**。固定正文、关系当前投影、证明链和历史退休的表示仍须单独定格式；不能一边声称增量认证，一边删除冷认证需要的依据。不要恢复全量旧 CP 正文，也不要为解决保留量强制切断调用。

冷恢复顺序：

```text
Store 完整读取并认证事实／索引／head
→ 核对 owner、父子身份、固定声明和终态资格
→ 同步解码并固定输入及正式事实；恢复契约重新检查
→ 核对最后保存 point 的准确布局、state 和 refs
→ 运行原 point.check；不能用另一个容易通过的点代替
→ 受控安装 Context／Relation 基线
→ 现有 Work/资源装配和访问控制签发恢复活动
→ waiting 子按现有规则核对它后来产生的准确 head
```

生产当前在构造时已做部分资源供给准备、在 begin 才运行原 point.check。迁移需区分**供给接线**和**可执行业务端点**：不得让未通过恢复资格的调用先执行 resume 或资源方法；若要把原 point 检查移到 capture 之前，还必须核对现有 capture 的合法依赖，不在这份设计中假称已有全局原子安装。

完整冷重建应覆盖以下字段，不用简化模型替换：owner/kind/parent、父契约、子声明位置/契约、准确 contextId、round/order/key、nextChildOrder、输入和 progress、returned 的成功或准确失败来源、pending/receiving/accepted/failed/handled、接纳登记位置、point/state/refs、独立最终 delivery。key 不是唯一身份；诊断来源可以是后代，但 refs 仍只能指向直接关系。

冷恢复可以全量付费，不沿用进程内 WeakMap 证据。关系存在不自动取得行动权限；已保存 receiving 只允许同契约重建活动。缺首个子 head、failed/cancelled waiting 子、版本不符、缺正文、终态续接继续拒绝；普通实体和宿主的效果核验仍保留。

### 完整返回值也会把全量工作重新带回来

低层 [CheckpointWriter.save](../server/invocation/src/checkpoint/contract.ts) 目前返回完整 CheckpointImage，已有测试读取它；不能把它当成无调用者的私有实现。业务 Work.checkpoint 则返回 void，没有要求收到完整镜像。

建议候选低层 save 返回已提交 head 的标识／准确回执，完整恢复视图通过明确读取取得。Store.read 与冷恢复 installed 观察可以继续完整物化；热 captured/saved 观察原本只含身份和 point，无需扩大。低层返回类型必须显式迁移，不能仅换数据库表示、仍在每次 save 尾部重建整个 Frame，然后声称热保存已无历史成本。完整读取不是业务作者需要多学的新必选步骤。

MemoryStore、Conversation SQLite 和 Observer SQLite 均在影响面内。事实共享后，退休旧 image 不能直接删除新 head 仍引用的正文；压缩仍要分别约束单块解压及完整重建。当前宿主单写锁、本地 Store 实例排他不因新格式变成跨进程租约。

### 两项不能顺手改变的表示限制

**currentInput。** 生产虽只运行一轮，但 v5 校验与低层 Context 安装仍容纳 input/currentInput 分别保存。第一份原型保留该逻辑字段；正常调用可引用同一已固定事实。若新格式删除，必须明确兼容/拒绝规则及历史 progress 投影，不能仅凭“现在通常相等”直接抹掉。

**容量。** 当前不是每行 8 MiB，而是完整逻辑 image 的 8 MiB，并有 4,096 个直接孩子、100,000 个值节点及深度限制。建议首份接入原型保留完整逻辑预算，用固定正文统计与关系/选择变化维护聚合量；新增格式要明确逻辑计量口径。拆行不自动放大可恢复调用容量；共享存储也不能按去重后的物理字节冒充完整展开量。若希望长任务突破现有上界，另行讨论容量与冷恢复成本，不用 continue-as-new 代替设计。

首次固定及编码仍须有受控内容预算；稳定值预算、持久格式预算、外部模型/资源预算互不代替。生产数值尚未由实验默认值定案。

## 7. 影响面与验收顺序

| 文件／包                                                             | 接入影响                                          | 必须保留的证据                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------- |
| contracts 的 I/O、ChildFacts、ReceptionValue、CP 端口                | 正式数据深只读、窄共同固定实现；后续选择/查询契约 | 原始值/tuple/泛型推导；不能用断言伪装只读，Error 和能力端口不误入值域 |
| Runtime construction/calls、construction/invocation，legacy 构造路径 | 固定输入早于捕获/收窄，恢复使用同一材料           | 根/子/低层构造、取消、回调重入、捕获失败不制造孩子                    |
| Invocation context、execution、relation、children                    | 唯一状态中安装固定内容、增量元数据与索引          | 候选/工作/交付分离；并发接纳、handled、取消收尾、关闭双失败           |
| Invocation checkpoint/{invocation,children,facts,restoration}        | 从 owner 取既成事实，首次编码，增量认证，冷安装   | 原资格矩阵及完整失败/progress；无子 CP；uncertain 不补写              |
| Runtime binding/{work,checkpoint,receptions,children}                | 逐点布局、按需事实和准确 refs、原恢复权限         | 真实服务不同布局、全量 check、旧选项误用、只读查询不能开行动          |
| Checkpoint contract/value/store/receipt                              | 新持久表示与原子提交、聚合预算和冷全量校验        | 缺失/多余/篡改/重排、CAS、拒重、终态、重算摘要仍不掩盖关系错误        |
| Conversation/Observer 持久与恢复                                     | 新 Store 适配及版本接纳；资格查询不能偷偷走热路径 | CLI/Web/resume 各入口、准确交互反馈/实体凭据、不重发                  |
| 实体包、记录与输出、Sequence/Dynamic、例子                           | 固定快照复用；正式交付消费者使用同一稳定值        | 不冻结实体本体；不丢真实来源和原异常；不混淆流式预览                  |

这里是用户已经授权的迁移影响清单。历史冻结盘点的 92 项失败是迁移面线索，不能机械删除旧断言，也不能当作本轮重新发现的失败数量。

建议按以下门槛推进，最终公开契约统一切换，避免永久双 API：

1. **按已定查询寿命推进，many 与作者增量基线延期。** 保留旧查询逸出、同点新选择、不同点布局、冷恢复最后选择的拒绝测试；普通 refs 数组每次完整处理。
2. **再做真实所有者窄原型。** 直接覆盖 Context／Relation 的完整字段和时序，CP on/off 都消费同一固定值；去掉外置 Observation 镜像。使用旧完整 Frame 只作冷重建及对照，不能把对照开销报为新热路径成绩。
3. **接通候选提交与真实恢复。** 新事实、选择、head 原子提交；缺失/坏回执/硬退出及宿主资格矩阵先通过。明确存储版本与旧库只读/拒绝规则，不能自动从旧活引用语义迁移事实。
4. **同一链路验收计算范围。** N=32/128/512/2048、固定输入大小及返回体积，分别测成立、首次编码、save、finish、查询、冷恢复。当前 lookup 与作者全量读取分开；未变化旧正文 encode/decode/reception.check 为 0，当前 point.check 不为 0；完整数组 refs 和大 state 如实计量。
5. **最后迁移生产和收敛文档。** 正式修订原引用/支持域、纯接纳检查、查询寿命、持久格式/容量及版本纪律，执行全仓类型、构建、回归与实际宿主恢复。实体前缀构造、内存卸载和退休仍是各自问题，不要求作者改调用边界。

收益目标是：后续热保存不因已经结束的历史孩子而重复遍历正文或检查旧接纳。它不等于所有 API 严格 O(1)，也不等于内存、磁盘、冷恢复已取得常量上界。

## 8. 迁移前设计轮依据与限制

本轮只读核对真实 Context/Relation/Execution/Invocation、构造/capture/refine、Work/point 绑定、Checkpoint/Store 及已有实验报告；独立交叉审查分别覆盖生命周期、作者契约和持久/恢复边界。

既有实验 **681/681 复跑通过**，两份既有 TypeScript 工程、相关文档格式与差异检查通过；沿用已构建工作区，没有重新执行全仓 build/check。没有新增“生产已经接入”的测试成绩。本轮报告中的伪代码是设计，尚不能替代自动插入真实边界、全部作者类型或完整宿主恢复的验证。

测试日志及本轮差异核验保存在 `.capix/facts-integration-design-20261107/`。原有未提交生产缓存等工作保留；本轮不修改生产代码、不访问真实模型或生产数据库、不重启服务、不提交。
