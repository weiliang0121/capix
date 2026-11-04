# 新对话服务的浏览器交付

浏览器与 CLI 使用同一条公开资源、结构和 Runner 装配，Web 宿主增加提交反馈、消息同步和检查端点。它不复用旧 Observer 的业务环境，不为界面重建 Task Group；实际 Scene 调用就是每次处理的观测根。

## 所有权

```text
web/host
  ├─ ConversationStore → Transcript / Memories / View
  ├─ ModelProvider → Interactions
  ├─ Scene + Resources + Interactions → Runner
  ├─ Recorder / RecordBook → 可选记录机制（Web 宿主选择安装）
  └─ HTTP
       ├─ 提交：保存有限的反馈投影，不执行业务逻辑
       ├─ 消息源：消费实体事件，基线与增量
       └─ 连接：订阅 / 解除，不能决定调用是否存活

SessionHttpTransport → ConversationSession
                          ├─ ClientSubmission
                          └─ TranscriptReceiver
                       → React 页面与按需检查器
```

结构不取得 HTTP 对象，提交不从 Recorder 推断内容是否落实。ConversationEvents 安装到 Runner 的普通观察与恢复 CP feedback，接收带真实来源的正式消息事件；当前入口只允许这条业务链写入消息。消息来源失效明确停止同步，不伪造完整基线。预览可丢弃或与最终正文不同，正式正文由 Transcript 同步交付。

## 从提交到接回

1. 页面读取单会话身份、服务受理状态，建立消息同步。
2. 发送前将提交定位保存到本标签页 sessionStorage；不保存正文或运行中间态。
3. HTTP 按单条用户文本接纳，服务 Runner 负责真正的忙闲与运行；客户端身份只是关联，不承诺跨进程幂等。
4. 输出增量与提交修订独立发送。正式助手追加即能显示，即使之后的维护尚未完成。
5. 最终状态取自 Runner 实际返回/失败，包括释放处理。停止请求不等于已经取消。
6. 浏览器断开只解除连接。刷新后先查询原 ID 并 follow；没有本地定位时可发现本进程当前活动提交。
7. 未知或淘汰的 ID 保持未确认，不重发。用户可检查实际消息后结束本地跟踪，再发一条新输入。

HTTP 仅有限保留本进程反馈。重启后内容仍在，提交与调用记录不恢复；“没有活动提交”不能反证旧输入未执行。发送、模型反馈、消息写入和记忆/View 操作仍是独立事实，不合并为事务。

## 传输与检查

- 消息同步使用一次基线和后续事件；慢连接结束后由客户端有限重连取得新基线。提交用 baseline/submission/answer 帧，预览按 offset 追加；提交慢连接明确换成当前基线，不积压无限增量。
- 预览达到上限后停止该候选预览，最终模型和正式消息链继续。订阅失败不取消外部发送。
- `/api/inspection` 按需提供当前记忆、View 成员及最近100次 Scene 调用的轻量目录。调用完整详情只在选择时读取，最多遍历4096个后代，截断显式标注。
- 记录完整性与业务结果分开。提案 failed 被维护 handled 后，树上保留原失败；记录源 incomplete 不伪装成完整轨迹。
- 刷新内容不自动重试模型，检查器也不发起业务调用。没有逐 token 发送整份实体或 RecordBook。
- 恢复候选是独立的发现操作，不随普通提交结束或检查器刷新查询。应用在每次会话初始化完成且宿主 ready、没有活动提交时自动检查一次；同一会话 ID 的重新初始化也适用。旧本地跟踪尚未判明时等待查询结果；确认在途或宿主 busy 时先跟随原提交，不在随后结束时补做自动检查。新本地提交尚在发送或跟随时，即便旧会话信息仍显示 ready，也禁止查询。用户可明确点击“检查可恢复处理”。本地未知跟踪不阻止只读检查，真正恢复仍须满足 canSend，不能借查询自动清除跟踪。
- 恢复检查区分未检查、加载、已检查（可为空）、过期和失败。新的提交、已观察到的消息／记忆／View 变化或连接变化使原结果过期并解除旧请求消费；过期响应不得回写，不把“未检查／暂不可查询”当作没有候选。页面只投影查询结果，不决定 CP 资格。
- 装载恢复能力的宿主在 `GET /api/recoveries` 前检查当前准入：busy 返回409、不扫描 CP；unavailable 返回503及准入错误。真正查询仍执行原 Store／业务资格校验，`POST /api/resume` 仍在派发前检查准入与准确依据。普通提交后的 `/api/session` 准入确认、提交 read/follow 不变；不修改 CP、增加轮询或跨查询缓存。
- 服务只监听本机，HTTP核对 Host、POST同源与JSON类型，输入有限，静态文件只来自构建目录；Provider配置和密钥不进入响应。

## 使用

```sh
pnpm build
pnpm conversation:web --demo
# 真实模式，凭据由启动宿主加载
node --env-file=.env services/conversation/dist/web/start.js --live
```

打开 `http://127.0.0.1:4318`，可通过 `--port` 或 `--db` 改变宿主配置。真实模式默认使用已有 `.capix/conversation.sqlite`，演示模式使用独立演示库。相同数据库单写者互斥，先正常退出原 CLI。Ctrl-C 停止接纳与本地调用，等待独立请求完成，再释放存储。

默认服务提供显式 CP 续接及独立的恢复活动摘要，见[有限恢复](conversation-recovery.md)。当前不提供多会话管理、文件任务或历史记录归档。开发界面仍可使用现有 Vite，以 `OBSERVER_API_ORIGIN` 显式指向新服务后打开 `/conversation.html`。
