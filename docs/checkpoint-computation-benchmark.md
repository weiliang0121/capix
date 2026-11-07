# Checkpoint 单步计算范围基准设计

日期：2026-11-06。状态：已实现并执行公共Runner基准，主实验扩展至2048子调用，结果见[实测报告](checkpoint-computation-results.md)、执行入口见[示例说明](../examples/checkpoint-computation/README.md)。下文保留实验设计及旧数据核对依据；本轮未修改生产保存点、Frame、Store或作者契约。

本基准用于区分固定输入、累计关系、引用选择和作者检查的成本，给后续增量表示提供依据。不预先选择哈希链，不以减少恢复屏障换取性能，不将会话分叉纳入范围。

## 1. 旧数据说明什么

已有 [CP 复用报告](checkpoint-reuse-validation.md) 的原始 JSON 保存了每次 Store save 的 point、contract、children、逻辑 bytes 和 elapsedMs。它可以重算单次 Store 成本分布，但没有完整 Work.checkpoint 耗时。

只读复算以下两个目录中各三次密集样本：

- `.capix/cp-reuse-study-20261106-153447/baseline-{1,2,3}/eight-models-32-slots.json`
- `.capix/cp-reuse-candidates-20261106-155132/combined-{1,2,3}/eight-models-32-slots.json`

每次 ToolLoop 均有 465 次 save。以直接子关系数拟合单次 Store elapsedMs，所得范围如下；这些是同一工作负载内的相关拟合，不是因果拆分，也不是新基准的结果。

| 实现           |       拟合截距 | 每条关系的拟合斜率 | 每次运行的单次保存中位数 |
| -------------- | -------------: | -----------------: | -----------------------: |
| 第一阶段旧基线 | 5.137–5.407 ms |   0.0440–0.0496 ms |         10.111–10.910 ms |
| 两项缓存组合   | 2.188–2.285 ms | 0.00718–0.00786 ms |           3.100–3.125 ms |

基线最终 ToolLoop head 中，frame.input 与 frame.currentInput 的 JSON 编码各为 255,464 B，值相同；两份合计 510,928 B，约 499 KiB。完整 image 为 1,056,092 B，其中 children 编码为 506,304 B、references 为 37,523 B。字段值的编码量不是精确的独占物理存储量，完整 image 还包含键名、分隔符及其他字段。

据此可以确认固定材料被重复放进完整镜像；尚不能把 5.3 ms 截距全部归给输入，或宣称消除输入重复就能节省约一半 CPU。旧样本的 children 实际为 1～232，没有 N=0 的测量，截距本身就是外推。

旧数据的使用边界：

1. 同一 run 的输入固定，但模型关系、工具关系、返回值、接纳状态、refs 和保存阶段一起变化。它是增长轨迹，不是严格控制其他变量的因果实验。Brotli 成本还受内容可压缩性影响。
2. 不根据采样占比将 Store elapsedMs 乘二，估计完整 CP 耗时。采样与逐次计时的对象和归属不同。
3. 不将 232 条关系内的线性拟合直接外推到 2,000 次工具调用。引用匹配存在更高阶项，容量限制也可能先触发。
4. 当前性能基线是已经安装两项缓存的实现；旧基线仅作历史对照，不与当前结果混成一组。
5. 原输入每次比较、每次执行 codec 是当前行为。只处理一次可能改变后续原地修改与非确定性 codec 的拒绝条件；输入引用化是否不改语义，需要单独证明，见 [已有反例](../test/checkpoint-reuse-boundaries.test.mjs)。
6. 第一阶段 baseline-1 在同进程小、中样本之后执行，baseline-2/3 及 combined 为独立启动；不同目录也处于不同测量批次。这里只复核增长形态，缓存改善仍以先前交错执行的 baseline-control 四组实验为据。

## 2. 测量目标和变量

目标是判断：正常推进是否重新处理了本步没有改变、没有读取的历史。比较单位以单次保存为主，整次入口为辅；恢复正确性单独验收。

| 变量 | 含义                          | 控制方式                                             |
| ---- | ----------------------------- | ---------------------------------------------------- |
| H    | 父调用原输入正文 UTF-8 字节数 | 固定种子生成，记录精确值及 JSON 编码量               |
| N    | 保存时累计直接子关系数        | 串行建立同一种 Node，每次处理相同大小的值            |
| R    | 当前保存的 refs 数量          | 当前一个引用，或全部历史引用；两组使用同一 many 槽位 |
| A    | 尚未结束或未完成接纳的关系数  | 主实验串行，派发前为 1，接纳后为 0；按阶段分别报告   |
| V    | 单个子返回值及父接纳值的大小  | 两者分别记录，主实验均使用固定小字符串               |
| S    | 作者 CP state 的大小          | 主实验仅固定形状的数字进度，不复制历史               |
| K    | 作者 point.check 的工作范围   | 主实验局部检查；全量历史检查是单独诊断组             |

输入大小使用 KiB/MiB 明确单位。正文长度、JSON 编码字节、压缩正文与数据库文件大小不能混称 bytes。

主实验要求 H、V、S、子结构数量和保存时机不随 N 改变。新建关系身份仍由真实内核生成，不伪造固定 contextId；字段长度和业务数据生成规则保持一致。

## 3. 场景与实验矩阵

### 3.1 公共结构基准

通过公开包构造 Scene → Group → Node。目标父层为 Group，Scene 的固定开销、子 Node 的保存与 finish 分开统计。通过真实 Runner、资源窗口和 CheckpointStore 运行，不使用只返回假回执的 Store。

Group 输入持有 H 大小的正文；Node 输入仅含小的步骤标识，不把父输入复制到每个子调用。Node 返回 V 大小的固定结果并保存自己的 completed 点；父接纳使用固定纯映射和明确 reception 契约。结构、资源、模型都不读取网络或本地对话数据。

父层每一步保持相同顺序：

```text
创建一个真实子调用与 ref
→ 保存 dispatch（A=1）
→ 子调用执行并接纳
→ 保存 accepted（A=0）
→ 下一步
→ 全部结束后保存 completed
```

成功样本的目标父层 save 为 2N+1，finish 为 1。其他层单独计数。这个规则用于固定基准工作量，不构成推荐的最小保存组合。refs 的数组维护发生在保存计时外，但仍计入整个 Group/run 的时间；不得将这部分成本隐藏掉。

局部 check 只检查固定形状的 state，以及最后一个引用的准确顺序，不调用 children.values/list，也不遍历历史。例如：

```js
check(state, facts) {
  if (!Number.isSafeInteger(state.step)) throw new Error('Invalid step');
  const last = facts.references.children.at(-1);
  if (last && last.order !== state.expectedOrder) throw new Error('Wrong child');
}
```

这只限制作者回调自身的工作量。当前 Runtime 为此仍会构造全部 savedCheckpointFacts 和槽位投影，其成本必须保留在完整保存时间中，不能标成整个检查链路已经局部化。

### 3.2 分阶段矩阵

不执行所有变量的笛卡尔积。先按下列小组分别定位，再选择必要的交叉点。

| 组            | 改变的变量                                 | 其他固定条件                                                           | 回答的问题                                          |
| ------------- | ------------------------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------- |
| A：关系规模   | N=32/128/512/1000/2048；R=1 或 N           | H=1 KiB，V=64 B，局部 check                                            | 全 Frame 历史成本与全 refs 成本分别怎样增长         |
| B：固定输入   | H=0/1 KiB/50 KiB/500 KiB/2 MiB             | N=0 或 128；无 refs 或当前一个；建立关系后连续保存相同形状 state 16 次 | 关系范围固定时，输入大小对单次保存的实际影响        |
| C：关系值大小 | V=64 B/1 KiB/16 KiB                        | N=128，H=1 KiB，R=1                                                    | 历史关系数量与历史正文体积各自的影响                |
| D：作者检查   | 局部 check / 显式遍历全部事实              | N=128/512，H=1 KiB，R=1                                                | 用户全量检查额外付出的成本，不混入内核复杂度        |
| E：宿主复验   | 合法范围内的真实 ToolLoop 小、中、密集样本 | 固定输入、模型轮数或工具槽位中的其他变量                               | CP 之外的 preflight、请求编码及交换预算是否仍是热点 |

组 A/B 先分别使用真实 MemoryCheckpointStore 和新 ConversationStore 的 SQLite CP 端口。组 C/D 先在 SQLite 跑必要交叉点，有疑问再补 MemoryStore；两者差值不直接称为磁盘 I/O，因为内部表示、校验和存量不同。

组 B 的连续保存使用独立 diagnostic 点：建立 128 条关系的成本另计，不纳入这 16 次样本；16 次之间保持关系、refs 和 state 完全相同，只有镜像身份与持久 revision 按机制正常变化。N=0 时使用空的 many 槽位，不伪造当前 ref。不复用要求真实派发/接纳进度变化的点检查。仅变化游标的变体可在必要时补充；该诊断组不承诺相应业务恢复意义，也不能代替组 A 的增长实验。

主数据使用固定种子生成的 JSON 安全文本，避免全部为同一字符。另选 H=500 KiB、N=128 的点，对照高度重复文本，单独观察压缩敏感性；不把旧实验的大段重复字符推广到任意文件内容。

### 3.3 容量与可达范围

- 当前 Frame 有 8 MiB、100,000 结构节点、4096 条直接关系三道限制。2048 或大值组合可能先失败。报告第几步、阶段、首次错误和实际可达前缀；不抬高生产限制，不将失败样本算成快速完成。
- ToolLoop 最多 32 次模型请求，每次最多 32 个工具槽位；正常最终正文需占一次模型请求，因此现有成功路径通常最多 992 个工具。2048 由普通 Group 验证，不通过放宽 ToolLoop 上限拼成“同一宿主实验”。
- 当前工具宿主没有交换历史压缩机制。未来的有界上下文长任务可以作为独立离线形态，不声称本轮已验证生产上下文压缩。
- 先跑 32/128/512 的试探，再扩展 1000/2048。试探每样本最多 120 秒，扩展最多 300 秒，由外部控制进程实施；报告解析上限固定为 16 MiB。触限标记为 timeout/limit，不继续自动重试。终止导致没有最终数字摘要时，将最后完成步数记为 unknown；SQLite 可另行只读核对持久前缀，但不能冒充完整的计时样本。

## 4. 三种独立测量模式

### 4.1 耗时模式

在 build 前包装基准声明的 run 和 resume.run，仅替换其 Work.checkpoint 函数，保持原函数、参数、返回和异常。做法沿用 [已有覆盖夹具](../test/fixtures/tool-checkpoint-matrix.mjs)，不添加生产测量接口，不穿透 Runner 的私有 Invocation。

```js
// 基准伪代码。slot 只持数字、固定阶段标签与状态。
function timedCheckpoint(checkpoint, options, slot) {
  const started = performance.now();
  try {
    const value = checkpoint(options);
    slot.succeeded = true;
    return value;
  } finally {
    slot.checkpointMs = performance.now() - started;
  }
}

// 同一个同步保存区间内，真实 Store 再建立嵌套计时。
function timedStoreSave(image, revision, slot) {
  const started = performance.now();
  try {
    return actualStore.save(image, revision);
  } finally {
    slot.storeMs += performance.now() - started;
    slot.storeCalls++;
  }
}
```

每个 Work 保存分配测试本地 sampleId，嵌套 Store 使用同一 ID；未进入 Store 就失败的保存也要记录。子 Node、Scene、Group 用不同 owner/contract 标签汇总。失败对象在停止测量后再格式化，数字结果中只保存错误分类。

必须明确三个时间边界：

| 指标                   | 包含什么                                                                    | 不应解释成什么                              |
| ---------------------- | --------------------------------------------------------------------------- | ------------------------------------------- |
| checkpointMs           | Work 授权/refs 转换、Invocation 捕获/编码/认证/check、Store、回执及同步通知 | 单纯 Store 时间，或纯 CPU 时间              |
| storeMs                | 真实 Store save/finish 内部工作                                             | 物理磁盘耗时                                |
| checkpointMs − storeMs | 同次保存中 Store 之外的同步耗时                                             | 可直接拆成捕获、认证、作者 check 的精确比例 |

finish 单独计时，不混进 Work.checkpoint 样本。process.cpuUsage 记录整个测量区间的进程 CPU；performance.now 记录同步经过时间，可能含 GC、调度暂停。不同实验的两个中位数不能相减当作同次调用分项。

默认关闭 Recorder、CPU profiler、逐次控制台输出及正文观察。只保留预分配或有界的数字数组；不保留 image、Work、refs、返回大值、错误对象或完整 JSON，以免测量人为延长其生命周期。

特别禁止在 Store wrapper 返回前追加 JSON.stringify 统计字节：即使已经停了 Store 的表，这仍在外层 checkpointMs 和整个 run 的计时内。旧脚本的 Store 数据可用，但不能直接套上一层计时充当新的完整 CP 基准。

### 4.2 字节与计数诊断模式

使用相同计划的独立进程和新 Store；允许额外计数和序列化，但本模式的 elapsed、CPU、峰值内存不用于性能结论。

每个样本记录：

- input/currentInput、state、children、references、完整 image 的逻辑编码字节；各层 save/finish 数量。
- 子关系总数 N、refs 数 R、活动数 A；按真实保存阶段区分 waiting 与 accepted。
- 作者 input/output/reception/state codec 的 encode/decode 次数及 point.check 次数。只用确定性透明 codec，计数不参与返回或拒绝条件。
- 单次及累计直接关系条目数；它表示要捕获的关系量，不冒充所有内部访问次数。
- refs 线性查找比较量单独标为“按当前算法推导”。没有公共计数出口时不伪装成实测，不全局替换 Array.find，不用 Proxy 改变生产值行为。

字节统计在获得真实 image 时进行，统计完立即释放引用。不得复用测试 Journal 中 images.push(image) 的全历史保留方式。

真实 SQLite 字节分三种报告：

1. 传入 save/finish 的累计逻辑 payload；
2. 数据库中当前 body/delivery 的存储字符串字节、身份行与 head 数；
3. 数据库/WAL 文件大小及运行前后变化。

第三项不是实际磁盘写入总量，自动 checkpoint、页复用和压缩都会影响它。如需逐次 SQLite body 编码量，可在独立诊断模式中于提交后只读相应行；该查询不进入正式耗时模式。公开 Store 端口无法提供的物理 I/O 不给估计值冒充实测。

### 4.3 CPU 采样模式

仅对代表性小点和一个大点独立执行，复用已有互斥栈分类器。用于定位差值来源，不把采样百分比乘 Store 时间，也不和无采样结果混合计算中位数。

需要 writer.save 精确边界时，可另用公开 Invocation/InvocationContext/checkpointWriter 的低层夹具，参考 [复用边界测试](../test/checkpoint-reuse-boundaries.test.mjs)。它不包含 Runtime 的 Work 与 refs 适配；不同夹具之间的差值不作为精确单阶段耗时。本轮优先公共 Runner 的完整作者保存入口。

## 5. 执行纪律与报告

1. 固定当前源码、构建产物和测试计划摘要。当前工作树包含未提交缓存与恢复测试，不能只写基线 commit 而省略实际改动；执行前选择清晰版本或保存相关摘要与改动清单，不读取 .env。
2. 不在构建、全仓测试或其他负载测试同时运行基准。每计划使用独立 Node 进程和新数据库，不复用真实会话库；不清理系统文件缓存来宣称冷磁盘。
3. 每计划固定一次 N=8、H=1 KiB、V=64 B 的预热，使用该计划的 Store 与 refs 策略，结束后关闭 Store、释放夹具，再建立全新被测 Store。预热规则对各规模相同，不强制 GC；记录首个 CP 与后续 CP，不能只丢弃慢点。建库、迁移、加载和 Runner.build 单列，不计入保存延迟。进程最大 RSS 包含预热，报告中明确标注。
4. 正式耗时模式至少三个独立重复，交错正反规模顺序；报告运行间范围。如果波动掩盖差异，再增加重复，不以一次极值判优劣。
5. 用无计时包装的同场景对照估计整个测量工具的扰动；另报告空函数定时的固定开销，但不直接逐条扣除。字节/计数模式只需证明与耗时模式的业务结果和事实数量一致。
6. MemoryStore 当前只保留每个调用的 head 和已用 imageId，不保留全部旧正文；它仍持有子 head 和身份集合，不是“零存储”。运行峰值 RSS 与测量区间堆快照分开，记录采样方法及开销。
7. 不混合不同 contract、point、phase 的分位数解释一个阶段。按相同 N 的 dispatch/accepted、以及增长区间分别输出 p50/p95/max 和样本量。

建议产物目录为被忽略的 `.capix/cp-computation-benchmark-日期时间/`，每组保存 manifest、纯数字逐次样本、summary、独立诊断报告及必要的 profile。原始 DB 留作检查，不进入 Git；不为查看曲线保存所有内存镜像。

最小报告字段：

```text
manifest: code/build/plan hashes, Node/OS/CPU, Store, warmup, repeat
plan: H, N, R-policy, V, check-policy, text-pattern, measurement-mode
sample: id, owner, point, phase, step, N, R, A,
        succeeded, checkpointMs, storeMs, storeCalls
diagnostic: id, fieldBytes, imageBytes, codecCalls, checkCalls,
            relationEntries, inferredReferenceComparisons
run: result, save/finish counts, elapsedMs, processCpuMs,
     RSS method/value, firstFailure, lastCompletedStep
storage: logicalPayload, retainedBodies, bodyBytes, head/image counts,
         dbBytes, walBytes, lifecycle checkpoint of measurement
```

时间与诊断运行用计划、步骤、阶段匹配，不假定随机 contextId 相同。一次保存尚未到达 Store 就失败时，imageBytes 应为空，不能记作零字节成功。

## 6. 如何据此决定后续方案

先输出曲线与事实，再决定优化。避免预设“截距只由输入决定、斜率只由子关系决定”的二项模型：refs、值大小、作者检查及压缩都有独立影响。

| 观测结果                            | 支持的下一项研究                      | 仍未证明什么                 |
| ----------------------------------- | ------------------------------------- | ---------------------------- |
| 固定 N/R 后，H 增大显著增加成本     | 固定输入的重复编码/表示与真实性核验   | 输入只处理一次不改变现有契约 |
| 全 refs 相比单 ref 出现额外高阶增长 | 引用认证索引、引用选择表示            | 索引化已解决全部历史编码     |
| 单 ref、局部 check 仍随 N 增长      | 全关系捕获与完整镜像表示              | 哈希摘要可以代替父接纳事实   |
| Store 之外的保存成本占主导          | 捕获、codec、Frame 解码、Work 检查面  | 仅改 SQLite 即可解决         |
| CP 已改善而宿主增长仍明显           | preflight、交换容量摘要、模型请求构造 | 这些都是内核 CP 的职责       |

后续增量候选的验收目标：固定本步变化量、活动集合、输入与作者访问范围后，扩大已封口历史不再触发全历史 codec、扫描和重复正文写入；必要索引查找可以有对数成本。不能只看耗时曲线近乎平坦，还要由计数和存储量证明处理范围缩小。

恢复矩阵继续独立使用 [恢复覆盖验证](checkpoint-recovery-coverage.md)。新方案还需补充已固定值修改、历史块缺失、摘要不符、乱序完成及提交失败等反例。范围测试通过不自动证明恢复承诺不变，恢复矩阵通过也不自动证明任意规模的性能。

## 7. 第一批落地范围

第一批只实现公共 Runner 的 Group 基准、真实 Store 装饰器、独立耗时/诊断模式及聚合报告。先执行 A 组的 32/128/512 和 B 组，验证计时边界及字段计费；再按实际耗时与容量扩到 1000/2048。C/D 和宿主 E 用于解释仍未归属的成本，不一开始扩成全仓性能平台。

在这些数据出来之前，不改变输入固定时机，不合并生产保存点，不改 Frame 格式，不采用哈希链，也不新增作者可见测量配置。
