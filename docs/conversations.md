# 对话身份与切换

Conversation 是一段持续交流的内容身份。当前落实 CMP 的 C 与已有正式消息 M；不新增 Part、Thread 或 REOA 层级。Conversation 不等于 BoundRuntime、一次 R 调用、Submission 或 HTTP 连接。

## 服务与持久身份

`ConversationDescriptor` 公开 `id/title/transcriptId/createdAt/updatedAt`。服务持久关联对话与其 Transcript、Memories；记录来源另行关联对话。消息仍用 `transcriptId + index` 定位，记忆仍由 Memories 接纳，记录仍是可选观测结果。

`ObserverConversations` 是 Observer 服务的目录与装配入口，持有共享数据库、惰性 ModelSource 与文件工作区引用。`list/get/create` 提供目录操作，`content` 恢复内容及消息同步，`open` 在执行或显式观测时装配该对话的运行结构与记录预设。它不增加 REOA 业务逻辑，也没有可变的“服务端当前对话”。

每个对话有独立 Transcript、Memories、SelectionUsage、变化消费与运行绑定。Provider 和文件工作区是共享服务资源；对话内容隔离不意味着文件目录隔离。打开后环境暂保留至宿主关闭，不实现后台会话淘汰与通用调度。

列表、元信息、消息读取及接纳查询不调用模型、不启动 Invocation。显式观测可以建立该对话的新记录来源；不会伪造历史执行。关闭视图只解除消费，不能关闭共享数据库或销毁未结束的 Interaction。服务退出与独立外部交互收尾沿用既有边界。

SQLite v3 把原有单对话元信息迁为默认 Conversation，保留消息集合、记忆集合、消息索引、记录和交互 ID。新建在同一事务中写入对话元信息及空消息、记忆集合。默认身份仅供首次选择，不参与后续请求的隐式路由。标题取首条正式 user 消息的前 48 个 Unicode 字符并合并空白；没有模型命名。最近更新时间由内容落实推进，浏览与观测不改变它。

## C/S 目标与提交

```ts
interface ConversationSubmissionRequest {
  readonly conversationId: string;
  readonly submissionId: string;
  readonly input: ConversationRequest;
}
```

提交身份首次登记时固定对话归属，累计反馈与接纳状态均明确携带 `conversationId`。之后 follow/read/cancel 依据已登记的 submission 查找，不读取页面选择。原有反馈故障、取消和未知结果规则不变，不承诺提交的持久重放或重启恢复。

| 接口                                                 | 目标                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------- |
| GET `/api/conversations`                             | 对话列表及 `defaultConversationId`                               |
| POST `/api/conversations`，空 JSON 对象              | 新建并返回 descriptor                                            |
| GET `/api/conversations/:id`                         | 读取确定的对话元信息                                             |
| GET `/api/conversations/:id/submission`              | 当前活动提交基线及对话/消息集合身份，没有活动项则省略 submission |
| POST `/api/run`                                      | 正文必带 `conversationId/submissionId/input`                     |
| GET `/api/conversation/admission`                    | 必带 query `conversationId`                                      |
| GET `/api/executions`、`/api/memory`、`/api/observe` | 必带 query `conversationId`                                      |
| GET `/api/execution`                                 | query `conversationId` 与记录 `id`，只读取该对话记录             |
| GET `/api/transcript`、`/api/transcript/observe`     | 必带实体 `id`，只读取服务提供的集合                              |
| `/api/submissions/:id` 及 follow/cancel              | 已固定的提交归属                                                 |
| `/api/config`、`/api/source`                         | 服务级配置与允许读取的源码                                       |

新建与 POST 执行是不同动作；创建空对话不追加输入、不调用模型。不存在的目标明确失败，不回退到默认对话。两个浏览器的选择互不改变对方的目标。

## 客户端的活动选择

ClientRuntime 仍是一套无 UI 的协调结构，增加目录读取与打开对话，不为每个历史项保留一个后台客户端或队列。

```ts
await runtime.initialize(); // 读取目录，优先打开宿主保存的对话，否则打开默认对话
await runtime.refreshConversations();
const conversation = await runtime.createConversation(); // 创建并打开
await runtime.openConversation(existingId);
runtime.enqueue({ messages: [{ role: 'user', content: '继续' }] });
```

快照中的 `conversation` 是选中 descriptor，`conversations` 是目录；`switching/canSwitchConversation/conversationError` 单独表达打开过程。入队时固定对话身份，真正 POST 时仍由服务作最终受理检查。

第一版只有当前提交已确认结束且等待队列为空时才允许新建或切换。未知结果不能因服务 ready、断流或点击历史而被丢弃。切换不会取消当前请求，也不清空、迁移待发送消息。

打开期间暂不接纳本地发送。取得目标元信息、有效消息基线及当前活动提交查询后才切换活动身份、提交跟踪与观测作用域；失败保留原对话。有活动项则接回其反馈，没有本地输入也可跟踪和取消。并发打开与旧连接回调有代次/身份检查。可选观测独立建立，失败不妨碍消息阅读和正常提交。

消息副本可按实体身份保留，旧对话消费连接停止；观测详情、游标及活动读模型不能跨对话沿用。历史内容恢复不恢复旧提交和执行实例。

Observer 的 sessionStorage 只保存当前标签页的对话/消息集合及未确认提交身份。刷新时读原提交，服务还在运行则继续跟随；服务已无法查询则保持未知，不按原输入重提。详见 [客户端接回](client-runtime.md#刷新后的接回)。这不增加服务提交持久化、服务重启续跑或后台多会话消费。

## 应用呈现

对话标题右侧提供新建、历史、配置三个入口。历史列表显示标题、最近更新时间与当前项；选中后消息和调用视图使用同一对话身份切换。配置继续按下一次提交捕获；原来的消息 JSON 追加功能明确标为“导入消息”，与历史对话列表区分。

App binding 负责把客户端状态投影为读模型、每帧统一写 Store；成功切换时重建投影并清理旧的 QA 选择和检查弹层。草稿、文件输入与待导入消息按对话保存于应用内存。消息展示与图谱按对话重建滚动和动画状态，不由渲染速度延长服务端运行。

本轮不增加删除、复制分支、改名、离线队列、后台会话调度或通用 Part 体系。
