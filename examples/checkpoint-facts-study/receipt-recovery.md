# CP finish 回执故障与恢复切点

状态：2026-11-06。独立实验，**15/15 通过**。使用已构建包的公开出口、真实 Invocation、Runner 和 CheckpointStore；不修改生产契约、Frame v5、恢复资格或稳定值策略。

本轮补足 [稳定交付实验](stable-delivery.md) 中必要 `finish` 故障之后的真实恢复边界：**候选内容已固定、正文完成、存储已有成功终态，都不能单独授权当前父层宣称成功；恢复还取决于父 head 是否未终结，以及子交付依据是否准确。**

## 实测矩阵

`receipt-recovery.test.mjs` 的 3 项低层测试分别注入提交前抛错、提交后抛错、提交后返回无效 revision 的回执。公开 `Invocation` 连接 `MemoryCheckpointStore`，父子均有真实 CP；父关系在调用前显式选择接收失败，并实际尝试 `relation.handle`。

三项均验证：孩子正文仅执行一次；孩子 `Context.status` 已为 succeeded，但父关系收到 failed，`failure.receptionAllowed === false`；handled 和 accepted 回调均未执行，reception 仍 pending。子 `finish` 只调用一次；父自己的失败终态正常持久化。提交后故障保留子的 succeeded delivery，提交前故障保留子的未终态 CP。父 image 中仍是旧 waiting 关系，但独立 delivery 已为 failed，Store 拒绝将其推进为成功。

另外 12 项通过 `receipt-process.mjs` 启动 27 次独立 Node 进程，连接临时 `ConversationStore.checkpoints` 的真实 SQLite 实现。恢复进程重新创建 Scene/Node 声明、资源和 Runner，经公开 `runner.resume(rootContextId)` 执行；没有导入私有实现或直接调用内部 resolve 函数。

| 故障或退出位置                                             | 退出后的持久依据                                          | 新进程恢复结果                                           | 实测业务执行                              |
| ---------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------- |
| 子 finish 提交前抛错，正常退出                             | 父 failed；子 completed CP，无 delivery                   | 根终态拒绝恢复                                           | 正文/效果 1 次，接纳/handled 0 次         |
| 子 finish 提交后抛错，正常退出                             | 父 failed；子 succeeded                                   | 根终态拒绝恢复                                           | 正文/效果 1 次，接纳/handled 0 次         |
| 子 finish 提交后返回无效回执                               | 父 failed；子 succeeded                                   | 根终态拒绝恢复                                           | 正文/效果 1 次，接纳/handled 0 次         |
| 子完成 CP 已保存，finish 提交前硬退出                      | 父 pending + waiting；子 completed CP，无 delivery        | 按原子身份 continuation，执行作者 completed 恢复点并接纳 | 正文/效果 1 次，子 resume 1 次，接纳 1 次 |
| 子 finish 提交成功、返回回执前硬退出                       | 父 pending + waiting；子 succeeded                        | 读取准确交付，以 delivery 模式恢复关系并接纳             | 正文/效果 1 次，子 resume 0 次，接纳 1 次 |
| 效果已发生、子首份 CP 前硬退出                             | 父 pending + waiting；无子 head                           | 明确 execution unknown，拒绝续接                         | 效果保持 1 次，不补跑正文或恢复点         |
| 子成功后的恢复读口分别替换 owner、input、contract          | 父 pending + waiting；读口提供不符子依据                  | 三项分别拒绝 parent-owned identity 不符                  | 不运行子正文、恢复点或接纳                |
| 子提交成功后抛错，父收到受保护失败、父 failed 提交前硬退出 | 磁盘父 pending + waiting；子 succeeded；旧父内存已 failed | 新进程按持久依据以 delivery 模式恢复并接纳               | 正文/效果 1 次，子 resume 0 次，接纳 1 次 |
| 子提交成功后抛错，父 failed 提交完成、回执前硬退出         | 父 failed；子 succeeded                                   | 根终态拒绝恢复                                           | 不因父回执丢失复活                        |
| 父成功提交完成后抛错                                       | 父 succeeded，镜像保存子 accepted；子 succeeded           | 原调用向宿主抛错，新进程拒绝终态恢复                     | 效果/接纳 1 次，不伪造失败终态            |

“硬退出”是在准确边界调用 `process.exit(73)`；退出点之后不再执行 catch、finally 或其他收尾。退出点之前已经发生的关系失败、正文失败或提交正常保留，不能把它们算作未发生。后续进程真正重新打开 SQLite，不沿用旧进程内存对象。普通异常则允许 Invocation 完成正常收尾；两者是不同实验，不能互换解释。

五类硬退出位置是效果后/子首份 CP 前、子 finish 提交前、子 finish 提交后、父 failed 提交前、父 failed 提交后。三项身份不符测试只在恢复读口注入改变后的完整 head，不篡改数据库；恢复拒绝后仍核对原子成功 head 未变化。

## 依据与判断

- 正常故障有明确父失败终态时，**父 image 里的旧 waiting 不表示父仍可恢复**。全部根终态拒绝测试核对根/子 head 和完整事件账本无变化，证明拒绝发生在作者执行与新写入之前。
- 父仍未终结且子成功 head 匹配原 owner/input/contract 时，现有 `resolveCheckpointChild` 路径能采用成功交付。测试核对原父/子 contextId、`child-restored.mode === 'delivery'`、子 head 完全未变化；不是重新发起子调用，也不执行子恢复点。
- 父失败尚未提交是单独边界：真实 Invocation 观察先记录子 failed return 的 `receptionAllowed === false`，随后记录根正文 `finished/failed`，最后进入根 `finish(failed)` 后、实际提交前退出。磁盘仍只有父 waiting 和准确子成功交付，新进程会恢复成功。事件顺序核验这不是“子失败还未传到父”的早期退出，也不是把已持久 failed 终态复活；旧内存故障没有被额外持久化为永久拒绝凭据。恢复进程只读取 CP，不消费验证账本。
- 子尚无 delivery 不一定缺乏依据：本实验的 completed CP 已保存准确输出，作者恢复点只返回已保存 state，故可走 continuation。**这只证明此恢复点，不证明任意副作用中断点都可重算。**
- 子 head 缺失时，即使独立账本能看到效果，也不会自动用它猜测交付。Runner 明确拒绝；本实验没有给恢复点接入该账本或增加“查到效果就成功”的旁路。
- 回执无效和 Store 抛错都可能发生在真实提交之后。它们阻止当前成功交付，不证明提交回滚；子不再次 finish，父不使用失败处理把受保护机制故障改成业务 fallback。

实现依据可定位到 `server/invocation/src/checkpoint/invocation.ts` 的 `commitUncertain`/`finalize`、`restoreChild`，以及 `server/invocation/src/checkpoint/children.ts` 的 `resolveCheckpointChild`。这些是只读审阅依据；测试运行只使用包公开出口。

## 验证与限制

```sh
node --test examples/checkpoint-facts-study/receipt-recovery.test.mjs
pnpm exec prettier --check examples/checkpoint-facts-study/receipt-recovery.test.mjs examples/checkpoint-facts-study/receipt-process.mjs examples/checkpoint-facts-study/receipt-recovery.md
git diff --check
```

上述定向测试 15/15 通过，格式检查与 diff 空白检查通过。测试文件不在根 `test/**/*.test.mjs` 默认 glob 内，需执行以上命令或 `node --test examples/checkpoint-facts-study/*.test.mjs`。本报告不声称全仓测试、真实模型或生产宿主恢复已验证。

测试使用临时 SQLite 文件与独立事件账本记录真实正文、效果、映射、save/finish 次数；账本不是恢复数据源。没有网络请求、模型发送、外部配置读取或已有业务库修改。SQLite 提交通过生产 Store 完成，异常/无效回执由测试包装端口注入；没有模拟介质损坏、操作系统断电、写入撕裂、多写者租约或跨实体事务。

这里直接构建通用 Runner。Conversation CLI/Web 的内容、模型请求/反馈、工具目录/策略与固定凭据等宿主资格仍需其既有检查；本实验不能放宽这些资格。其范围也不含子终态 failed/cancelled 的所有拒绝分支、任意声明版本变更或任意恢复点覆盖；相关既有矩阵见 [恢复承诺与保存组合验证](../../docs/checkpoint-recovery-coverage.md)。

本轮不安装 StableValues、不改变原返回引用、不证明所有值边界已迁移为稳定内容；它验证的是当前成功宣称与持久恢复机制。稳定候选值仍必须服从这些边界。
