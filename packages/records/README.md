# @weiliang0121/capix-records

保存调用、边界、资源操作与内容变更的可选观测记录，并提供子树快照的读取与校验。

## 安装与入口

运行环境为 Node.js `>=22.23.2`。包使用 ESM，附带 TypeScript 类型声明。

```sh
npm install @weiliang0121/capix-records
```

- `@weiliang0121/capix-records` 导出 RecordBook、Recorder、记录实体及观测辅助方法。
- `@weiliang0121/capix-records/construction` 向宿主的独立观测窗口提供 RecordWriterResource，用于创建、登记和更新记录。
- `@weiliang0121/capix-records/data` 提供纯数据形状、归档标识、输出解析及快照校验，可供浏览器或传输适配器使用，无 Node.js 或记录实体实现依赖。

## 用法

在宿主中创建 `new Recorder(new RecordBook())`，从 `@weiliang0121/capix-recording` 导入 `bindRecording`，通过 `bindRecording(recorder)` 把观测安装到 Runner。可执行示例展示了资源登记、调用以及如何从同一 RecordBook 读取结果。[示例源码](https://github.com/weiliang0121/capix/blob/main/examples/records.mjs)

## 快照与校验范围

`CallableRecordHelper.snapshot` 读取调用方选定的子树及其真实祖先路径。业务任务的选择、跨环境汇总和展示由应用负责。`validateExecutionRecordSnapshot` 检查调用与上下文身份、父子链、调用正文和状态、边界顺序、资源阶段及内容记录归属。Transcript 投影还检查 transcriptId、正安全整数 revision、可解析的 occurredAt 和变更区间。追加要求 `0 ≤ start < end`，分段要求 `0 ≤ previousStart < start < end`，索引均为安全整数。Memory 投影检查非空白的 memoryId 和 memoriesId、正安全整数 sequence，以及可选 operationId 的格式。记录正文仅包含 create/update、可选原因和 content 展示值。`observeMemory` 组合当前内容与可用记录，完整元数据和恢复材料由实体维护。

同一调用的资源操作与转交的领域事实共享序号。领域事实可单独投影，因此资源记录的正安全整数序号允许跳号，但须按所属调用严格递增。子树校验与记录簿载入均检查绑定阶段和 started/returned/threw 配对。序号空缺不能证明遗漏了效果。

`ExecutionRecordHelper.snapshot` 与 `validateLegacyExecutionRecordSnapshot` 对应 runtimeCall、execution、operations、attempts、边界和资源组成的记录表示，该格式没有 Transcript 或 Memory 数组。两种校验都只用于读取观测数据。原先从 protocol 导入归档和记录形状的代码应改用本包的 `/data`，共同调用词汇从 contracts 导入。

## 契约与版本记录

- [详细契约](https://github.com/weiliang0121/capix/blob/main/docs/recording.md)
- [按版本查阅 CHANGELOG](https://github.com/weiliang0121/capix/blob/main/packages/records/CHANGELOG.md)
- [MIT 许可证](LICENSE)
