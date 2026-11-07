# Checkpoint 计算基准

这个示例通过公开的 `Scene → Group → Node → Runner` 链路，测量单次 checkpoint 保存怎样随输入体积、直接子关系数量和 refs 数量变化。使用真实 `MemoryCheckpointStore` 或新建 `ConversationStore` 的 SQLite 端口，不调用模型，不读取现有对话库或 `.env`。

它测量现有机制的计算范围。2026-11-07 起使用生产 Frame v6 的增量提交，保存次数和作者完整 refs 数组保持不变；旧 v5 数据仍按当时报告解释。设计与解释边界见 [基准设计](../../docs/checkpoint-computation-benchmark.md)；恢复安全性见独立的 [恢复覆盖验证](../../docs/checkpoint-recovery-coverage.md)。

## 工作量

目标父层是一个 Group。Group 输入包含 H 字节的材料，每次创建同一种 Node；Node 输入是固定宽度的步骤标识，返回 V 字节的字符串。父接纳使用固定纯映射，不把 H 复制成每个 Node 的输入。

`growth` 家族的每一步依次执行：

```text
创建子调用 → 父 dispatch 保存 → 子执行并接纳 → 父 accepted 保存
完成 N 步 → 父 completed 保存
```

成功运行时：

| 层         | save 次数 | finish 次数 |
| ---------- | --------: | ----------: |
| 目标 Group |  `2N + 1` |           1 |
| 全部 Node  |         N |           N |
| Scene      |         1 |           1 |
| 合计       |  `3N + 2` |     `N + 2` |

这些次数固定基准工作量，不代表业务的最低必要保存组合。每条关系仍有真实的调用身份。`refs=current` 仅保存当前引用，`refs=all` 保存累计引用，两者使用相同的 many 槽位；all 模式维护数组的成本位于单次保存计时之外，但包含在整次 run 中。

`input` 家族先建立并接纳 N 个 Node，期间不保存 Group 的 dispatch/accepted 点；随后在独立 `diagnostic` 点连续保存 16 次。16 次使用同一个 state 对象、同一个 refs 对象和相同关系，仅镜像身份与修订按机制正常推进。N=0 使用空引用数组。建立关系的成本仍包含在整次 run 中，单次输入实验只分析 Group 的这 16 行。它的成功 save 数为 Group 16、Node N、Scene 1。

两种家族都不承诺恢复验证。Group 的恢复函数明确拒绝；Scene 用闭包传入材料也是为了隔离目标父层输入，不是完整的恢复业务设计。不能用性能样本成功推断任意中断位置可恢复。

## 三种运行模式

| 模式         | 收集内容                                                                          | 使用限制                                              |
| ------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `timing`     | 单次 Work.checkpoint 及嵌套 Store 保存时间、独立 finish 时间、整次 run 时间与 CPU | 用于耗时比较；不统计 JSON 字节，不累计 codec 回调次数 |
| `diagnostic` | 镜像及字段的 JSON 字节、codec/check 回调次数、关系条目、算法推导的 ref 比较量     | 独立进程执行；其整次耗时受诊断影响，不用于性能结论    |
| `control`    | 不包装 Work.checkpoint；保留 Store 成功次数、归属和 finish 数值记录               | 是仅计数对照，不是零测量开销的对照                    |

`checkpointMs` 包含完整的原始 Work.checkpoint 同步调用；`storeMs` 是其中真实 Store.save 的嵌套时间。应在同一行做差，不能用两组独立中位数相减。差值只能称为“Store 以外的保存耗时”，不能直接称为捕获时间。finish 在 checkpoint 之外单独记录。

`performance.now()` 记录经过时间，包含 GC 或调度暂停；`cpuMs` 来自整次 run 的进程 CPU 用量。open、构造与 build 分别报告，不计入 run 计时。计时模式仍包含少量计时及数值采集开销，需要用 control 对照估计，不能逐条机械扣减。

诊断中的 `inferredReferenceComparisons` 是历史字段名：v6 delta 路径按两次索引检索乘完整 refs 数量推导，不再是 v5 的线性 `find` 比较量；它不是插桩得到的比较次数。`codecCalls` 同时包含命名 codec 回调与 `.check` 回调，`diagnostic.checkCalls` 提供后者合计。`diagnostic.submittedPayload` 只累计送入 Store 的实际 delta/finish，既不是完整逻辑镜像总量，也不是磁盘写入，不能和旧报告的 `logicalPayload` 当成同一口径。

## 执行

在仓库根目录使用项目要求的 Node/pnpm 版本。先完成构建和小规模夹具检查，结束后再测量，勿与构建、测试、格式化或其他压测并行。

```sh
pnpm build
node --test test/checkpoint-computation-benchmark.test.mjs
mkdir -p .capix
```

输出目录必须尚不存在。以下命令分开运行；复跑时换用新的目录。

```sh
# 第一批：32 个配置，每个配置 3 个独立进程，共 96 个耗时样本。
node examples/checkpoint-computation/run.mjs --suite first --mode timing --repeat 3 --out .capix/cp-computation-first-timing

# 同一批配置的字节与回调诊断，和耗时采集分离。
node examples/checkpoint-computation/run.mjs --suite first --mode diagnostic --repeat 1 --out .capix/cp-computation-first-diagnostic

# 第一批完成且未触及容量边界后，再扩展到 1000、2048 条关系。
node examples/checkpoint-computation/run.mjs --suite extended --mode timing --repeat 3 --out .capix/cp-computation-extended-timing
node examples/checkpoint-computation/run.mjs --suite extended --mode diagnostic --repeat 1 --out .capix/cp-computation-extended-diagnostic
```

套件内容：

| `--suite`    | 配置                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------- |
| `first`      | growth：N=32/128/512 × current/all × Memory/SQLite；input：H=0/1 KiB/50 KiB/500 KiB/2 MiB × N=0/128 × Memory/SQLite |
| `extended`   | growth：N=1000/2048 × current/all × Memory/SQLite                                                                   |
| `supplement` | SQLite 的 V=1 KiB/16 KiB；N=128/512 的作者全量 check；两种 Store 的 500 KiB 重复文本对照                            |
| `overhead`   | N=128、current/all、Memory/SQLite，用于分别运行 timing/control 对照                                                 |
| `all`        | first、extended、supplement 的配置集合，不包含 overhead                                                             |

没有特别配置时，H=1 KiB、V=64 B，作者 check 仅查本步 state 和最后引用，文本使用固定种子生成的 JSON 安全文本。全量 check 与高度重复文本属于独立对照，不代表主实验。

单点检查和测量扰动对照：

```sh
node examples/checkpoint-computation/run.mjs --suite first --case growth-sqlite-current-32 --mode timing --repeat 1 --out .capix/cp-computation-single

node examples/checkpoint-computation/run.mjs --suite overhead --mode timing --repeat 3 --out .capix/cp-computation-overhead-timing
node examples/checkpoint-computation/run.mjs --suite overhead --mode control --repeat 3 --out .capix/cp-computation-overhead-control
```

`--case` 必须是所选 suite 中的准确 ID。可查阅 `plans.mjs`，或只打印计划，不启动任何样本：

```sh
node --input-type=module -e "import { benchmarkPlans } from './examples/checkpoint-computation/plans.mjs'; console.log(benchmarkPlans('first'));"
```

控制器依次启动独立 worker，每份样本使用独立结构和新 Store。每个 worker 先执行 8 步 control 预热，再创建新的测量结构与 Store；只允许代码/JIT 复用，不复用预热关系或数据库。重复批次交替使用计划正序、逆序，`manifest.json` 保留准确顺序。

## 上限与失败

- 控制器默认 N≤512 的样本期限为 120 秒，N>512 为 300 秒。期限包含 worker 导入、预热和最终报告；`--timeout SECONDS` 可以覆盖，范围为大于 0 且不超过 300。
- worker 超时由控制器 `SIGKILL` 结束。标准输出与标准错误合计超过 16 MiB 也会终止；最终 JSON 报告单独限制为 16 MiB。
- 内核现有的 8 MiB 镜像、100,000 结构节点与 4096 直接关系限制不提高。夹具另外限制 N≤4096、H≤8 MiB、V≤1 MiB，实际可能先触及内核边界。
- 同一配置第一次失败或触限后，其余重复标记为 `not-run`，不自动重试。报告的状态可能为 completed、failed、timeout、output-limit、not-run；报告缺失或无效会停止控制器。
- 可捕获的业务运行失败保存错误链、步骤、阶段和最后完成步数；强制结束且没有最终报告时，完成前缀未知。不能把这种样本当作一次更快的运行。

2048 步样本是普通 Group 的能力实验，不是 ToolLoop 的生产上限测试。本例不扩大 ToolLoop 的模型轮数或工具槽位，也不包含上下文压缩。

## 输出与复算

```text
OUT/
  manifest.json
  summary.json
  CASE-r1/
    plan.json
    result.json
    warmup.sqlite       # SQLite 样本
    sample.sqlite       # SQLite 样本
  analysis.json         # 执行 summarize 后生成
```

`manifest.json` 保存 Git HEAD、未提交状态与 diff 摘要、源码及构建产物哈希、运行版本、硬件基本信息和计划顺序。不记录环境变量、凭据、用户名或主机名。当前工作树可能带有缓存实现等未提交改动，因此比较时必须核对文件哈希，不能仅依据提交号把结果称为同一基线。

`result.json` 中：

- `report.samples` 是逐次保存数据。先按 `owner=group` 分离目标父层；增长曲线按 `point=accepted`、准确 N 分析，避免混合 dispatch 的在途关系。
- `report.stores` 包含成功 save/finish 次数、分层归属、总时间和独立 finish 行。应先核对次数与上述工作量一致。
- `report.timing` 包含 open/build/run 时间和 CPU。`processUsage.maxRssKiB` 是整个 worker 的高水位，包含导入、预热及报告阶段，不是目标 Group 的独占内存。
- `report.diagnostic` 和诊断样本提供字段计费与回调计数，不持有所有历史镜像对象。
- SQLite 的 `storageBeforeClose` 与 `storage` 分开记录关闭前后文件大小。Store 关闭后才用只读连接统计镜像身份数、保留正文数、压缩正文和最终交付长度；这些存量不是累计物理写入量。

聚合已有报告不需要重跑样本：

```sh
node examples/checkpoint-computation/summarize.mjs .capix/cp-computation-first-timing .capix/cp-computation-first-diagnostic
```

脚本在每个目录重建 `analysis.json`，保留逐进程摘要和按配置聚合的中位数、最小值、最大值。增长实验另给 accepted 阶段的关系数量分段和末步数据；输入实验只以那 16 次 diagnostic 点作为目标父层样本。

维护者复算时按以下顺序：

1. 先检查 `summary.json` 状态与 `result.json` 的结果 N、save/finish 数量，失败与超时单独列出。
2. 核对 manifest 中计划、模式、源码/构建哈希以及 Node/SQLite 版本；不同代码或采集模式不能混成重复样本。
3. 使用 timing 数据比较相同阶段、相同 N 的单次保存，和整次 Group/run 总量。每个准确 N 每进程只有一个 accepted 样本，三个进程仅给三个观测，不据此宣称可靠 p95。
4. 分段 p95 只描述该进程该段里的多次保存，它同时包含不同 N，不是单一 N 的置信区间。聚合先按进程汇总，不把同一进程的相关保存混成大量独立样本。
5. 再用独立 diagnostic 报告解释字段体积、回调次数及 refs 比较规模；与 timing 配置核对结果和保存次数相同。
6. timing/control 仅用于估计本工具的整体扰动；Memory/SQLite 的差值也不能直接称为磁盘 I/O，两者校验与内部表示不同。

本控制器没有 CPU profile 模式。需要采样定位热点时另开单独实验，不把采样进程的耗时并入上述 timing 结果。

## 稳定事实迁移复验

`--suite migration` 保留原工作量：N=128/512/2048 × current/all × Memory/SQLite；另含 H=500 KiB/2 MiB、V=16 KiB 对照。all 仍每次完整提交 refs，并通过 `facts.references.children.at(-1)` 取得最后项。早期实现会在查询时构造完整事实数组；当前查询已改为惰性映射，但 all 的完整提交仍付全量成本。比较旧报告时以各自 manifest 的代码版本为准。

```sh
node examples/checkpoint-computation/run.mjs --suite migration --mode timing --repeat 1 --out NEW_DIRECTORY
```

重复输入实验的第一次 save 发布输入和所有新关系，之后15次只发布 state/refs；`fieldBytes.input=0` 表示这次没有提交输入正文，不表示逻辑镜像没有输入。完整逻辑镜像的8 MiB约束仍按每次出现计算，物理复用不能绕过容量认证。

无 CP 的补充使用真实 Runner 和普通材料对话服务：

```sh
node examples/checkpoint-computation/fixed-boundary.mjs --out NEW_DIRECTORY
```

每配置两个独立进程，Runner 用三层调用比较原始对象和已固定值，服务每次建立相同32条历史并执行一次真实材料装配、离线Provider及正式消息追加。构建与 `stableValue` 预固定成本单独记录；服务没有模型网络等待、CP、记录器或SQLite。字符串本身不可变，2 MiB文本不意味着要复制2 MiB字符。100,000项对象则会在未知输入进入时遍历一次。原始/可信对照来自同一版本，不能冒充迁移前后对照；服务总耗时还包含Schema、JSON、实体与资源操作，不能全部归因于稳定值。

## SQLite 关系读取诊断

`relation-query.mjs` 在独立 diagnostic 进程中观察关系行点查、非空行、返回编码字节及 child 封套解析次数，复用原有提交探针计数变化关系。它不修改生产实现，退出时恢复临时挂钩；带挂钩的耗时不能用于性能比较。

```sh
node examples/checkpoint-computation/relation-query.mjs NEW_DB NEW_JSON 128 all
node --test test/checkpoint-relation-query-benchmark.test.mjs
```

模式支持 `current|all|incremental`。SQL返回字节不是物理磁盘I/O；解析复用不意味着减少SQL读取或refs认证。增量模式另观察选择头和新增/删除出现项的点查次数。计时继续使用上面的 `--suite migration --case ... --mode timing`。之前的构建摘要、直接基线与扩展结果见[关系查询验证](../../docs/checkpoint-relation-query-validation.md)。

## 增量选择对照

`--suite selection` 在相同版本中对比 all 完整数组与 incremental 有序选择。每个孩子仍保存派发前、接纳后两个点，最后再保存 completed，父层次数为 `2N+1`。两个模式读取同样的最后一项，不合并保存点，也不省略事实；另设 full-check 负对照，明确作者全量遍历仍付费。

```sh
node examples/checkpoint-computation/run.mjs --suite selection --mode timing --repeat 2 --out NEW_DIRECTORY
node examples/checkpoint-computation/summarize.mjs NEW_DIRECTORY
```

计时包含完整 `work.checkpoint`；同时报告整次 run，以包括保存外的 `select/add` 与数组构造成本。diagnostic 模式报告提交字节、新增/删除出现项、关系变更数和全量 check 访问数；不以诊断进程耗时作性能结论。每个样本使用新进程和新库，运行顺序在第二轮反转。结果见[增量引用选择](../../docs/checkpoint-selection.md)。
