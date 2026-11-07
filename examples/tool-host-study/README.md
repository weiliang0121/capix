# 工具宿主验证

使用真实 `createConversationHostAssembly → Runner → ToolLoop → Interaction → SQLite` 链路。离线模式替换模型传输，不绕过 Provider 编码、工具节点、消息接纳、维护或 CP。它是兼容与成本样本，不是性能上界或模型准确率基准。

```sh
pnpm build
node examples/tool-host-study/run.mjs --out .capix/tool-host-study-new
```

默认三个样本逐步增加模型次数、工具槽位与输入材料，最大样本为 8 次工具模型请求、前 7 次各 32 个工具调用。维护模型请求另计。使用重复英文历史，不能视为所有编码/Unicode/反馈组合的最大开销；硬上限的拒绝由独立单元测试覆盖。

真实模型必须显式启用，并由宿主环境提供 `DEEPSEEK_API_KEY`、可选 `DEEPSEEK_MODEL`。脚本不读取 `.env`，不自动重试，不覆盖已有目录。

```sh
node examples/tool-host-study/run.mjs --live --out .capix/tool-host-live-new
node examples/tool-host-study/run.mjs --live --case edges --out .capix/tool-host-edges-new
```

`--live` 默认运行所有 5 组：非思考 3 次提交、思考 2 次提交、无效消息索引、请求发出后取消、局部等待 1 ms 超时。`--case` 可选择 `live-nonthinking`、`live-thinking`、`live-invalid`、`live-cancel`、`live-local-timeout` 或 `edges`；离线可选目录中对应名称。取消/超时后的 `settled()` 等待仅用于确认独立反馈保存，不延长本次调用的生命周期。

每组独立数据库，预置消息为人工项目数据。产物：

- `summary.json`：每组结果、请求数、逻辑存量、save/finish 次数、同步持久耗时、退出后载入数量和关闭后检查的持久反馈数。`checkpointRetention` 分别统计镜像身份行、仍保留的正文、已淘汰的正文和调用 head。
- `<case>.json`：CP 分解、阶段、token/cache usage、最终回答及模型工具参数。未保存凭证、headers 或 reasoning 正文；回复完整材料仍按宿主约定保存在数据库中。
- `<case>.sqlite`：关闭后的真实持久事实。脚本先关闭宿主独占存储，再开启只读连接检查反馈，不能在宿主持锁期间另开 SQLite 查询。

`totalCheckpointSyncMs` 只测保存端口调用的同步耗时，不包含调用侧此前捕获/编码或其他资源工作。每次提交的 `cpuMs` 是该区间的进程 CPU 时间，不是 CP 专属 CPU。`totalCheckpointWriteBytes` 继续累计成功 save/finish 的逻辑 payload，不包含 SQLite/WAL 开销，也不因淘汰旧正文而减少。逻辑 JSON 存量、累计 CP 写入和 SQLite/WAL 大小分别报告。缓冲与测量比值不构成“未来一定不会超额”的保证。

`processUsage.maxRssKiB` 是整个独立 Node 进程的 RSS 高水位，包括导入和报告准备，不等于 CP 缓存大小或精确堆分配量。对照实现时使用相同脚本、独立进程和新数据库，交错重复运行；保存次数、逻辑字节和实际交付应一起核对。脚本不会切换生产实现，候选对照的构建选择由实验宿主负责，不能在运行期间替换 dist。

实际结果及已知限制见 [宿主验证报告](../../docs/native-tool-host-validation.md)。

## CP 计算采样

在离线样本中显式开启 V8 CPU 采样。采样围绕每次 `entry.run`，不改写生产源码或构建产物，不安装候选缓存；Inspector 启停会有少量边界开销。数据库打开、结构构建及最后检查不在该采样窗口中。

```sh
node examples/tool-host-study/run.mjs --out .capix/cp-baseline-new --case eight-models-32-slots
node examples/tool-host-study/run.mjs --out .capix/cp-profile-new --case eight-models-32-slots --cpu-profile
```

先串行运行基线，再运行采样，重复对照；不要与其他性能测试并行。`--cpu-profile` 不接受 `--live`。每次入口额外生成原始 `.cpuprofile`，可以导入 Chrome DevTools；`turns[].cpuProfile` 提供按调用栈归类的样本、加权时间和占比。

分类优先归属外层阶段：旧 head 读取包含其解压和认证，子关系捕获包含其 codec 和纯值复制，存储编码包含 JSON/Brotli。样本只计一次。GC、idle、未分类以及测量脚本自己的字节统计独立保留。`sampleMs` 按 V8 `timeDeltas` 加权，**不是精确阶段耗时或调用次数**；未分类不能全部算成 CP。原始栈及汇总都保留，方便复核归类。采样会增加开销，不能把采样／基线差异解释为性能优化收益。

同一轮的复用边界测试与测量结论见 [CP 复用验证](../../docs/checkpoint-reuse-validation.md)。

## CP 保留迁移复测

对已有且已关闭的 v5 **实验库**先核验文件状态和摘要，再复制到新目录；所有 SQLite 检查都在参考副本和测量副本上执行，避免只读连接在原目录生成 WAL/SHM。不要传入正在运行的服务数据库；原库存在 WAL/SHM/journal 时会拒绝复制。

```sh
node examples/tool-host-study/retention.mjs \
  --source .capix/tool-host-offline-20261106b/eight-models-32-slots.sqlite \
  --out .capix/tool-host-retention-migration-new \
  --repeats 3
```

每个测量阶段使用独立进程。`openMs` 包含真实 `ConversationStore.open` 的锁、检查与迁移，`closeAndUsageMs` 包含存量读取及关闭；计时不含模块加载、复制和事实摘要核验。最大 RSS 含进程启动与模块加载，不解释为纯迁移分配量。未清理操作系统文件缓存，不是冷磁盘测试，也没有进行调用恢复资格检查。

脚本核对所有镜像身份和修订、当前 head 正文与终态、其余内容/交互/交换表的摘要未变，原库文件字节不变；新旧正文数与存量分别报告。每次使用独立副本，不发起调用或模型请求，不执行 VACUUM，结果和副本写在新的 `--out` 目录。
