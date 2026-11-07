# 真实调用中的显式续接与协调重放

隔离验证目录。接续 [共同模型对照](../recovery-comparison/README.md)，使用真实 Scene → Group → Node、资源窗口、Transcript 固定接纳与 SQLite CheckpointStore。没有迁移生产实现，没有调用真实模型。

本实验的 `replay` 是作者在现有 `checkpointPoint.resume` 中明确选择重进协调函数：保存过的读取与接纳走事实查询，尚未完成的接纳走当前窗口里的真实子调用 API。它仍依赖 Frame v5、point、state、refs、reception 和 resume.deps/uses；不是内核已经提供的透明重放功能。

## 复现

在仓库根目录执行：

```sh
pnpm --filter @capix/conversation-service... build
node --test examples/recovery-runtime-study/*.test.mjs
node examples/recovery-runtime-study/study.mjs .capix/recovery-runtime-study-local
```

study 的目标目录必须尚不存在；数据库与逐切点报告保留在该目录。测试使用独立临时目录，结束后清理。`process.exit(73)` 表示故意跳过清理的进程消失，resume 由新进程执行。

单独查看业务观察的恢复接缝：

```sh
node --test examples/recovery-runtime-study/observation.test.mjs
```

这个测试包含**反例断言**：当前恢复业务事件不被转交，测试通过代表复现了缺口，不代表该行为已经满足期望契约。普通业务观察和恢复资源观察均设有严格失败对照。

## 文件与边界

| 文件                                               | 职责                                       |
| -------------------------------------------------- | ------------------------------------------ |
| `scenario.mjs`                                     | 真实结构、资源和两种恢复写法               |
| `process.mjs`                                      | 新进程入口、持久存储、故障注入和结果采集   |
| `store.mjs`                                        | 真实内容与 CP 存储、独立诊断事件和读取报告 |
| `harness.mjs`                                      | 子进程启动及切点列表                       |
| `recovery.test.mjs`                                | 正常运行、硬退出续接及真实故障断言         |
| `observation-process.mjs` / `observation.test.mjs` | 独立验证恢复业务观察出口与严格失败边界     |
| `study.mjs`                                        | 保留数据库、逐次结果与源码摘要             |

诊断事件只作测试观察，不供恢复读取。实体效果、CP、输出分别拥有自己的提交或交付边界，没有把它们包装成原子事务。预览不确定窗口的拒绝是本实验选定的保守策略，不是新增的内核要求。

结果和限制见 [验证报告](../../docs/recovery-runtime-validation.md)。
