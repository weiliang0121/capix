# 运行示例

先从[便签助手](../guide/getting-started.md)开始：读取会议记录和项目计划、整理三项待办、新增便签，再给出最终回答。默认使用离线固定决策脚本，另有显式配置的 `--live` 入口。

这些示例在 Node.js 中运行，只使用 CAPiX 公开包和示例自己的业务对象。统一检查只走离线路径；页面中的源码直接来自 `examples/`，不在浏览器中启动框架或调用模型。

```sh
pnpm build
pnpm examples:check
```

检查器逐个启动独立 Node.js 进程。示例中的断言核对结果、实体状态或输出事件；工厂模块由检查器显式调用，模块导入成功本身不算通过。

| 页面                                    | 入口                                          | 检查的行为                                               |
| --------------------------------------- | --------------------------------------------- | -------------------------------------------------------- |
| [便签助手](../guide/getting-started.md) | notes-assistant                               | 两份材料读取、真实新增便签、工具反馈和最终回答           |
| [结构与资源](./structure.md)            | dictionary、runner、presets                   | 字典查询、缺项回退、Sequence 写入和 Dynamic 每次调用隔离 |
| [实体与视图](./content.md)              | entities、view、view-membership               | 旧快照不变、成员调整、实体仍保留正文                     |
| [工具、输出与记录](./runtime.md)        | tool、runner-output、records、invocation-exit | 工具反馈、输出订阅释放、记录事实、关闭故障归属           |

单个例子也可通过 `node examples/view.mjs` 等命令运行。`dictionary.mjs` 与 `presets.mjs` 导出工厂，检查器会构造 Runner 并实际运行。`entities/domain.mjs` 与 `view/skills.mjs` 是组合示例使用的辅助模块，不作为空运行入口计数。

这些教学例子不承诺持久化、跨进程排他、外部效果幂等或任意位置恢复；具体边界由 [当前契约](../README.md)定义。
