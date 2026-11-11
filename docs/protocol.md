# 消息传输契约与业务协议边界

`@weiliang0121/capix-protocol` 仅提供明确的 Transcript 基线、增量、错误帧，以及 `acceptTranscriptUpdate` 单帧接纳。根出口是唯一入口。

## 真实归属

| 内容                                                  | 当前所有者                                      |
| ----------------------------------------------------- | ----------------------------------------------- |
| Message、定位、TranscriptSnapshot、TranscriptEvent    | `capix-transcript` 领域 API                     |
| Memory 内容、metadata、更新、持久依据与事件           | `capix-memory`                                  |
| 共享调用／父子关系身份                                | `capix-contracts`                               |
| 调用事件与阶段词汇                                    | `capix-invocation/events`，根出口重导同一份定义 |
| 记录数据、归档身份、输出解析、记录树校验              | `capix-records/data`，纯数据出口不加载记录实体  |
| TranscriptWireMessage／Snapshot／Event、Frame／Update | `capix-protocol`                                |
| 业务聚合 DTO 与端点接纳                               | 具体宿主                                        |

表内框架包都使用 `@weiliang0121/` scope。领域类型回到拥有行为的包；能跨端读取不意味着必须移入 protocol。只有明确的传输表示和接纳才由 protocol 维护，框架实体、Invocation 和 Runtime 不反向依赖它。共同类型的晋级规则见[契约与协议](contracts-protocol.md)。

## 当前 wire

```ts
import { acceptTranscriptUpdate } from '@weiliang0121/capix-protocol';

const update = acceptTranscriptUpdate(JSON.parse(payload));
// baseline: { type, snapshot: { id, revision, start: 0, end, starts, messages } }
// delta:    { type, event: { type: 'transcript', transcriptId, revision, occurredAt, origin?, change } }
// error:    { type, code, error }
```

消息只表达 user／assistant 与正文。基线为完整集合，从 0 开始；增量为 messages-appended 或 segment-started。当前 wire 保持既有消息同步形状，没有新增协议协商或传输实现。修改公开形状需要明确升级消费者，不自动将旧格式补成新事实。

接纳先固定输入，再检查准确字段、角色、非空正文、安全整数、集合长度、分段及 revision 的帧内合法范围；拒绝访问器和未知字段，不执行输入 getter。返回的固定材料不随调用方修改原对象变化。普通 JSON 能保真表达本 wire 的限定值域，不代表任意 Stable 值都能用 JSON 持久化。

**接纳一帧不代表接纳一条连续的流。** 集合身份匹配、连续 revision、重复交付、原正文是否被改写、连接替换与有限重建，仍由具体消费者负责。单帧错误也不自动取得重试、取消或恢复资格；HTTP、队列、预览、持久恢复和 UI 不进入本包。

## 宿主协议

提交、admission、预览、文件、配置、恢复候选与聚合流由宿主自行定义版本和接纳规则。框架不提供 Conversation／Observer DTO、HTTP 路由或 UI。业务协议引用框架领域类型时仍须明确 wire 表示，不能直接传递活实体、能力对象或内部事实。

## 独立验证

`packages/protocol/test` 用真实 Transcript 的空／非空基线、追加及分段事件，验证 JSON 往返、固定材料和拒绝反例。记录核验在 records 测试，调用事件在 invocation 测试，领域行为在 transcript 测试。仓库外候选／发布消费夹具另验证公开出口和严格类型消费，不从相邻仓库读取源码或测试。
