# 显式恢复与受约束协调重放

这是独立协议实验，**不修改生产 Invocation、Frame 或恢复资格**。它接续调用事实实验，比较同一组事实之上的两种推进写法，而不是比较 CAPiX 与其他框架的优劣。

场景：固定入口 → 读取材料 → 模型子调用返回 → 父接纳中落实实体 → 接纳成立 → 根终态。

- `scenario.mjs`：直接对照 `explicitAuthor` 和 `replayAuthor`。
- `model.mjs`：双方共用的固定输入、命令意图/结果及外部准确回执。实验使用受限 JSON、单写者、三个串行操作。
- `process.mjs`：独立进程运行/恢复及硬退出；两个 SQLite 数据库没有跨库事务。
- `recovery.test.mjs`：中断、二次中断、失败处理、终态与旧材料。
- `contract-boundaries.test.mjs`：契约漂移、未知效果、隐式副作用及命令后缀。
- `cold-validation.test.mjs`：较晚切点的共同冷验证，区分历史损坏与旧代码变更。
- `runtime-boundaries.test.mjs`：真实 Runner 负对照与普通 Promise 并发反例；不是生产重放适配。
- `study.mjs`：保存逐切点数据库、效果计数和源码指纹。不是 CPU 或服务容量基准。

从仓库根目录运行（真实 Runner 探针需要已构建的工作区包）：

```sh
pnpm --filter @weiliang0121/capix-runtime... build
node --test examples/recovery-comparison/*.test.mjs
node examples/recovery-comparison/study.mjs .capix/recovery-comparison-new
```

输出目录必须尚不存在，避免覆盖证据。没有网络或真实模型调用。

单个切点示例：

```sh
node examples/recovery-comparison/process.mjs run /tmp/capix-replay-study replay '{"cut":"entity-effect"}'
# 上一步预期退出码 73：跳过 finally。
node examples/recovery-comparison/process.mjs resume /tmp/capix-replay-study replay
```

实验不是通用恢复库，不提供任意 JS、工作窗口、完整父子树、权限、并发调度或生产恢复格式。模拟 World 的回执明确属于实验宿主；它没有被计数表推导出来，也不把无回执视为未执行。详细结论见 [对照报告](../../docs/recovery-replay-comparison.md)。
