# CP 作者契约：生产用法核对

2026-11-07。只读核对真实服务用法，为本目录的下一轮实验提供约束；不修改生产 API、Frame、恢复承诺或调用生命周期。表中行号来自本轮工作树，不把实验接口当作当前公开能力。

## 三个代表场景

| 场景                | 当前证据                                                                                                                                                                                                   | 候选必须保留的表达                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| ToolLoop            | [loop.ts](../../services/conversation/src/tools/loop.ts)：112 行登记模型和各工具的 many；195–197、309–314 行在执行前保存引用；237–246 行处理 accepted/handled；302–305 行预检拒绝不创建孩子                | 同声明的多次实例、waiting 引用、已处理失败、准确当前角色、无子调用的业务推进。登记完整关系与选择恢复角色不能合并        |
| MemoryMaintenance   | [maintenance.ts](../../services/conversation/src/memory/maintenance.ts)：32–44 行核对 proposal 与 apply；46–61 行 completed 的 refs 为空，仍检查旧 proposal，skipped 时禁止 apply；95–126 行保存原捕获材料 | 槽位移除后旧关系仍可精确查询；handled/skipped 与 succeeded/ready 保持区别；同一事实在不同 point 下有不同组合要求        |
| MaterialPreparation | [input.ts](../../services/conversation/src/materials/input.ts)：22–29 行 captured 的 state 是完整材料、resume 直接返回；39–45 行捕获 View 后保存，再返回                                                   | 固定局部材料是必要续接依据；可以先持久保存正文、后续 head 引用，不能强制只保留 cursor。材料存在不能证明本层已经成功交付 |

补充：ToolLoop 的 `confirmExchanges`（248–277 行）核对真实交换正文、feedbackDigest 与 operation 凭据。CP 内部事实通过认证，不能替代资源／实体上的恢复资格核验。`state.exchanges`（48–54、317 行）本身也随模型次数增长；仅改善 refs 不代表整条业务链成本有界。

## many 当前是有序数组，尚未约束为集合

[SavedReferences](../../contracts/src/checkpoint/references.ts) 的 many 是 readonly array。[checkCheckpointReferences](../../server/invocation/src/checkpoint/facts.ts)（55–61 行）检查槽位名称、基数和所属声明；[savedCheckpointFacts](../../server/runtime/src/binding/checkpoint.ts)（64 行）按保存数组次序投影。

这些通用检查没有禁止同一引用重复出现，也没有强制数组按实际调用顺序排列。ToolLoop 自己选择按调用顺序追加。这意味着新的增量写法必须区分**关系身份**和**槽位中的出现位置**：重复加入同一 child 可以产生两次出现；删除其中一次，不删除另一次、更不删除关系事实。若未来想统一禁止重复或强制排序，需要单独讨论其契约变化。

本轮类型候选用 `Occurrence<SlotScope>` 表示一次出现，`addReference(slot, child, { before })` 显式选择次序，`removeReference(slot, occurrence)` 删除准确出现；single 槽位仍表示一个作者选择的角色。名称只用于实验讨论。

## 不变量与检查范围

1. 完整直接关系由机制登记；当前角色由作者选择，不能仅从 accepted 关系自动推导。waiting、handled 和同声明多实例都有实际用法。
2. refs 不是唯一事实入口。移除槽位或 completed 使用空 refs，不会抹掉父层已经接纳的事实。
3. `delta` 可以帮助选择新增检查，但不能成为唯一视图：没有子变化时，state、point 或角色选择仍可能变化，必须允许按准确身份读取旧事实并核对新组合。
4. delta 以已确认提交的 head 为基线。check／编码失败不消费待保存变化；进入 Store 后回执不确定不能按未提交继续；冷恢复重新认证。
5. 机制负责身份、所属声明、接纳契约与状态转移；业务负责模型交换前缀、query 与材料、skipped 与 apply 等语义关系。优化不能以预设的业务规则冒充普适内核规则。
6. state 可以承载必要局部内容。一次保存正文、后续引用，是表示选择；不能把“state 必须只有位置”升为业务约束。
7. 固定局部材料、子返回、父接纳与根终态分开。保存 captured 材料后发生取消或关闭故障，仍不能制造成功交付。
8. 保持调用身份和生命周期不变；本轮不引入强制分段或 continue-as-new。

## 类型实验的范围

[author-types.ts](author-types.ts) 是编译期候选，验证 single/many、准确成员 I/O、接纳值类型、槽位出现身份、局部材料引用与交付关系的区别。它不声明 JavaScript 模型的类型，也不证明未来工厂、Work、Runner 或泛型辅助函数的完整推导。

运行：`pnpm exec tsc -p examples/checkpoint-facts-study/tsconfig.author-types.json`。通过条件包括正确调用可编译、19 个 `@ts-expect-error` 位置确实失败；没有使用类型断言或 `any` 隐藏不兼容。手工 unique symbol 只证明这个候选可表达成员与槽位区别，不证明任意工厂实例自动获得不同类型。相同声明不同调用仍具有相同静态类型；父子身份、准确出现与阶段权限必须由运行期反例验证。
