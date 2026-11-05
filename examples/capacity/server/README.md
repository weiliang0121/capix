# 独立 HTTP 负载与多进程容量

这个实验延续上一级的多会话验证，把负载发生器移到独立进程，经真实 HTTP 调用公开的 `createConversationWebHost`；模型模拟器也在独立进程。用于测量服务器的处理容量和多进程扩展效果，不新增生产部署机制、不修改内核。

已完成的14档负载与边界解释见 [2026-11-05 实测](./results-20261105.md)。

```text
独立负载进程：固定到达时间，消费 NDJSON，验证预览/终态
      │ 按固定会话 → 端口映射直连
      ├── worker 0：若干独立 WebHost / Runner / SQLite
      ├── worker 1：若干独立 WebHost / Runner / SQLite
      └── worker N：若干独立 WebHost / Runner / SQLite
                    │ 同一外部地址
                    ▼
             独立 HTTP/SSE 模型模拟器
```

当前公开 WebHost 是单会话服务。因此本实验在各 worker 中为每个会话建立独立的本机端口，并固定会话归属；同一个会话不会跨 worker，同一个数据库不会同时打开多个写者。它没有增加生产路由器，也没有验证故障转移、共享数据库竞争或跨实例接回。

## 运行

先按仓库要求构建。随后在根目录运行：

```sh
pnpm build

# 小规模功能回归，1/2 worker，各8会话，快速模拟模型。
node examples/capacity/server/run.mjs --smoke --out .capix/http-capacity-smoke

# 默认探索：200会话，1/2/4 worker，每worker每秒10/20/30次提交，各30秒。
node examples/capacity/server/run.mjs --out .capix/http-capacity-screen

# 例如4个worker，总计80次/s，持续60秒。
node examples/capacity/server/run.mjs --workers 4 --rates 20 --duration 60 \
  --out .capix/http-capacity-confirm

# 较大材料：初始历史32 KiB，回答8 KiB。
node examples/capacity/server/run.mjs --workers 4 --rates 10 --duration 30 \
  --history 32768 --output 8192 --out .capix/http-capacity-large
```

`--rates` 指**每个 worker 的提交率**，总提交率为 worker 数乘该值。`--users` 是全进程合计的固定会话数，默认200；不是每秒创建200个新会话，也不是200个浏览器。每档使用新进程和新库，结果目录必须不存在。每档最多10000次提交，最多8个worker/500会话；不要并行运行其他压测、构建或测试后拿结果直接比较。

全部使用本机模拟模型，不读取 `.env`、真实API Key或已有对话库。默认上游每次回答目标1秒、20片、约2 KiB；记忆提案目标100毫秒且返回空变更。每个会话初始2 KiB私有历史和一条私有记忆，之后历史随提交累积。SQLite、独立交互保存和CP全部开启，主动记录保持idle，恢复列表不轮询。

## 统计和判定

- 固定计划轮转会话，不等待上一次完成，不排队重试。真实busy和故障均保留；高压下可能某会话尚忙，拒绝数不会藏起来。
- `ClientSubmission` 接纳真实修订与预览，必须得到完整的committed预览和最终completed。HTTP200本身不是成功。
- 提交终态只提供正式答案定位，因此测量期间不追加全量历史查询。宿主关闭后通过公开Store重载，核验准确query/answer正文及私有记忆/View，再把nonce和消息索引与每条HTTP结果逐项对应。
- 所有模型请求另行统计。默认业务允许记忆提案失败后保留回答，这种降级仍让容量实验失败，不把“回答成功”视作完整链路成功。
- 每worker独立测CPU、事件循环和RSS；CPU100%表示一个核。报告的RSS峰值之和不是同一时刻的整机内存实测。
- 发生器单独计量CPU及计划到实际发送的延迟；每5秒报告发起、完成和仍在途数量。时延同时保存从实际发送和从计划到达起算的值，成功/拒绝/失败分开。
- “完整负载通过”不意味着“体验合适”。忙碌拒绝会使当前速率不通过，但它本身是正常的接纳保护，不等于内核发生状态错误。本实验额外使用完成p95不超过2秒、首增量p95不超过0.5秒、发生器调度p99不超过50毫秒的探索线；这不是框架保证或产品SLA。

结果含 `environment.json`、`summary.json`、`report.md`，每档还有逐请求/模型指标的 `result.json`、各worker日志及实验数据库。所有运行产物在被Git忽略的 `.capix` 中。原始数据不能通过源码仓库自动获得，应在分享结论时同时注明配置。

## 如何理解容量

区分三种数字：已保留的会话数、当前在途提交数、每秒完整成功提交数。固定200会话并不表示200个请求一直同时运行，平均在途数还取决于响应时间。

单机容量由各服务worker、共享存储、上游和传输共同约束。这里的模型模拟器与发生器虽然独立，但仍在同一台机器；必须结合它们的利用率和调度延迟判断是否成为瓶颈。多个worker同样会竞争磁盘、CPU和内存，不能把单worker吞吐简单乘核心数。

30/60秒是探索样本，边界应以更长的稳态测试和真实业务材料确认；历史持续增长、非空记忆写入、更大输出、真实模型限额、生产代理与网络都会改变结果。最高通过点只代表已测通过点，不是单机绝对峰值。

## 文件职责

| 文件         | 职责                                           |
| ------------ | ---------------------------------------------- |
| `plan.mjs`   | 有界速率/worker配置与样本矩阵                  |
| `run.mjs`    | 串行运行各档，协调所有进程，核对跨端与持久结果 |
| `host.mjs`   | 启动、IPC通信、超时和关闭服务worker            |
| `worker.mjs` | 固定会话装配、真实Web宿主、进程计量及闭库核验  |
| `load.mjs`   | 独立固定到达HTTP消费、反馈接纳与时延统计       |
| `report.mjs` | 将结果投影成报告，不参与执行                   |

共用上一级 `measurement.mjs`、`upstream*.mjs` 和闭库 `measureStorage`；生产服务不依赖examples。回归在 `test/capacity-server.test.mjs`。
