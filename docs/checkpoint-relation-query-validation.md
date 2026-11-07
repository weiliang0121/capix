# SQLite 关系查询：精确行依据复用验证

日期：2026-11-07。基线为 `ee96942`，候选不修改 Frame v6、调用事实、保存点或 refs 契约，只复用已经认证过的关系行解析结果。

**SQLite/all 的明显回退已消除，但 all 的完整选择仍然有随历史增长的成本。** N=512 时父层完整保存累计从本轮直接基线 11.323 s 降至 3.161／3.234 s；每次保存仍读取准确 SQL 行，并逐项核对全部 refs。收益来自相同行不再重复解析、验证存储封套和复制关系元数据。

## 1. 范围与测量

- 同一公开 `Scene → Group → Node → Runner` 夹具、SQLite Store、H=1 KiB、V=64 B。每个孩子派发前和接纳后各保存一次，父层为 `2N+1` 次；整次入口 save 为 `3N+2` 次，finish 为 `N+2` 次。
- `current` 只选择当前孩子；`all` 每次重新提交累计 refs 数组，作者通过 `facts.references.children.at(-1)` 读取选择。后者仍会构造整个选择结果，没有改写作者行为。
- `checkpointMs` 包含完整同步 `work.checkpoint` 及其 Store.save。父累计只统计目标 Group，finish 不混入其中。Store 时间包含认证、解析、SQL 等工作，不能称为纯磁盘耗时。
- Apple M3 Max、Darwin 25.6.0、Node 22.23.2、SQLite 3.51.3。每组独立进程、新库，先预热8步；计时期间不运行其他测试或构建。无真实模型、网络或记录器。
- 候选构建前，直接重跑基线 all128、all512、current512 各一次。候选覆盖 all128/512/2048、current512/2048，并独立复测 all512、current512。不是统计置信区间或服务器容量测试。
- SQL／解析计数使用另外的 diagnostic 进程。它们可能与功能测试并行，**耗时一律不作为性能证据**。

每份结果保留 manifest、计划、逐次保存及进程结果，目录为 `.capix/checkpoint-relation-query-20261107/`，汇总为 `comparison.json`。各 manifest 记录 Git HEAD、工作树差异摘要以及源码／dist 文件 SHA-256。筛选清单中所有 `/dist/` 条目、按原有顺序序列化后计算 SHA-256：

| 构建         | dist 清单 SHA-256                                                  |
| ------------ | ------------------------------------------------------------------ |
| 三组直接基线 | `48dab0b7555c8dc7072b165e5101c934c4e27bff8c96d8c8c58ac05246a7c647` |
| 七组候选计时 | `ef5cbed076968dfad14149a774f0061d010cd0726c506194760d8190918ebecd` |

组内构建摘要完全一致。共同 HEAD 是 `ee96942ff20bbf6a2e7c81cadd106346df99fd01`；候选是该提交上的未提交改动，不能用共同 HEAD 冒充相同构建。

## 2. 直接前后对照

| SQLite 配置    | 基线父累计 |     候选父累计 | 基线父 save 中位数 | 候选父 save 中位数 |
| -------------- | ---------: | -------------: | -----------------: | -----------------: |
| all，N=128     |    0.803 s |        0.347 s |           3.104 ms |           1.286 ms |
| all，N=512     |   11.323 s | 3.161／3.234 s |          11.545 ms |    3.005／3.084 ms |
| current，N=512 |    0.801 s | 0.749／0.727 s |           0.718 ms |    0.673／0.665 ms |

all512 的父累计减少约71%～72%，Store 部分从9.615 s降至1.873／1.927 s。current512没有同等幅度收益：它本来就不反复读取已退出当前选择的历史关系，小幅差异不用于宣称普遍提速。

all512 末次 accepted 从21.069 ms降至5.553／5.620 ms。相比[上一轮最终构建](stable-facts-migration-performance.md)的父累计9.669 s，以及[原 v5 三次中位数](checkpoint-computation-results.md)6.520 s，本轮也已低于两者；这些跨轮数字仅作历史参照，直接前后对照以上表为准。

所有前后样本均完成全部步骤；all512和current512均为父1025次保存、总1538次save、514次finish。没有减少保存次数、放宽预算或省略选择认证。

## 3. 扩展到2048个孩子

| 候选配置        |         父累计 |     Store 累计 |  父 save 中位数 |   末次 accepted |       整次 run |
| --------------- | -------------: | -------------: | --------------: | --------------: | -------------: |
| all，N=128      |        0.347 s |        0.246 s |        1.286 ms |        2.046 ms |        0.437 s |
| all，N=512      | 3.161／3.234 s | 1.873／1.927 s | 3.005／3.084 ms | 5.553／5.620 ms | 3.509／3.594 s |
| all，N=2048     |       46.471 s |       24.401 s |       10.933 ms |       21.778 ms |       48.034 s |
| current，N=512  | 0.749／0.727 s | 0.682／0.661 s | 0.673／0.665 ms | 0.656／0.686 ms | 1.084／1.062 s |
| current，N=2048 |        3.014 s |        2.768 s |        0.649 ms |        0.657 ms |        4.311 s |

N=2048 的父层4097次保存、总6146次save和2050次finish全部完成。current 的单次成本未随关系总量明显增长；all 的单次中位数从512到2048约增长3.6倍，父累计约增长14.5倍。**完整选择仍产生接近平方增长的累计工作，这次只消除了其中一项重复处理。**

上一轮 all2048 的约181 s父累计来自与小测试交叠的运行，不作为本轮精确提速比例的分母。本轮该配置没有并发测试。

## 4. 计数证明省掉的是什么

新增离线诊断入口 [relation-query.mjs](../examples/checkpoint-computation/relation-query.mjs) 观察真实 `Statement.get` 与关系记录封套的 `JSON.parse`：

- `relationSqlReads`：关系点查的实际调用数，包括查不到旧行的情况。
- `relationSqlRows`：实际返回的非空关系行数。
- `relationSqlBytes`：这些行的编码 body 字符串按 UTF-8 累加；是 JS／SQLite 边界的返回量，不是磁盘读字节。
- `relationEnvelopeParses`：`capix.checkpoint.record@1` 的 child 封套解析次数，反映关系解码路径的调用；不代表所有认证操作的总数。
- `changedParentRelations`：实际提交的父层变化关系条目，独立来自已有提交探针。

| 样本            | SQL 点查 | 返回关系行 | 返回 body 累计 | 关系封套解析 | 提交变化关系 |
| --------------- | -------: | ---------: | -------------: | -----------: | -----------: |
| 基线 all128     |   16,641 |     16,512 |   20,518,790 B |       16,512 |          256 |
| 候选 all128     |   16,641 |     16,512 |   20,518,790 B |          256 |          256 |
| 候选 all512     |  263,169 |    262,656 |  327,411,974 B |        1,024 |        1,024 |
| 候选 current128 |      258 |        129 |       90,866 B |          129 |          256 |

同规模 all128 的 SQL 点查数、返回行数和编码正文累计量**完全不变**，解析从16,512次降为256次。成功样本中，行数与解析次数之差对应准确行内容匹配后的解析复用；并不表示这些引用没有被检查。all512 同样保留262,656次返回行，只对首次观察到或实际变化的1,024份关系表示执行解码。

current128只有129次非空读取，没有重复历史解析可省。它与all具有相同256条变化关系，但读取范围不同，说明变化量与当前选择范围必须分开计量。

诊断测试同时验证完整Runner结果、保存次数、变化条目、两种选择的实际读取差异，以及正常／失败退出后恢复原始诊断挂钩；该测试独立运行1/1通过，不混入此前已启动的全仓测试计数。

## 5. 复用依据与未改变的拒绝边界

复用归单个 Store／连接，key 包含 owner 和 child ID。每次命中前仍获取最新 SQL 行，并逐项比较 `child_id`、`ordinal`、`body`。准确行相同才复用已认证解析；不存在、内容变化或身份变化均不能借旧依据通过。当前提交仍核验完整 refs 的每一个出现项。

热连接专项回归32项通过，覆盖变化／删除／错误序号／错误身份的行、pending到receiving到accepted的真实推进、重复refs中的错误target/order/owner、失败事务、冷热读取边界等。完整 `pnpm check` 的构建、类型、3321项测试及格式检查全部通过（0失败、0跳过），上述32项包含在内；新增诊断测试在全仓测试列表建立后加入，另单跑1/1通过。日志为同产物目录的 `check.log`。本报告的计时不替代拒绝反例。

缓存默认最多4096项、16 MiB保留材料计费，按近用淘汰；该计费不是JS堆或RSS精确上限。缓存被清空、淘汰或冷恢复后允许重新解析，不能把热证据当作磁盘数据仍存在或仍正确的证明。此次2048个孩子落在容量之内；更大的全量循环可能发生淘汰和重新解析，不能把本轮命中率外推到任意规模，也不通过提高预算来获得结论。

## 6. 剩余成本及下一项边界

这次结果支持保留准确 SQL 行检查下的解析复用，恢复了SQLite/all相对旧实现的收益。它没有把所有作者写法变成增量：

1. 作者仍每次构造、提交整个refs数组，编码和认证为 `O(R)`。
2. SQL仍按选择读取整行并比较内容；相同字符串比较也不是零成本。
3. 作者读取 `facts.references.children` 仍取得全部R个查询结果，后续只取最后一项不会追回已经付出的工作。
4. 当前state及作者check仍按当前组合执行，没有缓存任意作者判断。

若继续降低all的剩余成本，应先审视“完整选择的提交与读取”怎样保持准确出现项、目标认证和作者声明的恢复范围。那属于后续接口／契约议题；本轮没有替作者省掉其实际声明的历史范围。

## 复现入口

```sh
# 独立计时；每次使用新目录。N和模式可选本报告中的migration配置。
node examples/checkpoint-computation/run.mjs --suite migration \
  --case migration-growth-sqlite-all-512 --mode timing --repeat 1 \
  --out .capix/relation-query-timing-new

# 独立计数；每次使用新数据库及新JSON。不能拿该模式的时间作比较。
node examples/checkpoint-computation/relation-query.mjs \
  .capix/relation-query-new.sqlite .capix/relation-query-new.json 128 all

node --test test/checkpoint-relation-query-benchmark.test.mjs
```

原始计时分组为 `baseline-all-128`、`baseline-all-512`、`baseline-current-512`、`candidate-all-128`、`candidate-all-512`、`candidate-all-2048`、`candidate-current-512`、`candidate-current-2048` 及两个 `candidate-repeat-*-512`。独立计数JSON为 `baseline-diag-all-128`、`candidate-diag-all-128`、`candidate-diag-all-512`、`candidate-diag-current-128`，均在上述同一产物根目录。
