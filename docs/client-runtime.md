# 客户端 Runtime

ClientRuntime 分别持有业务交付状态、消息实体副本和可选观测状态，不依赖 React、HTTP 实现或服务端对象。client/runtime 公开 ConversationTransport、TranscriptTransport 和 ObservationTransport 三个契约；应用通过 conversation / transcripts / observation 具名参数接入。

接口分类不等于 HTTP 实例拆分。ConversationHttpTransport 同时实现业务交付和消息实体契约；ObservationHttpTransport 提供独立的观测接口，两者共用通用 HttpTransport。

## 只使用对话

```ts
const conversation = new ConversationHttpTransport();
const runtime = new ClientRuntime({
  conversation,
  transcripts: conversation,
});
await runtime.initialize();
await runtime.submit({ messages: [{ role: 'user', content: '你好' }] });
// 结束客户端订阅，不取消服务端已经接纳的业务。
runtime.stopTranscript();
```

ConversationTransport 只要求 config、run；TranscriptTransport 提供 transcript(id?, signal?) 查询与 observeTranscript(id, accept, signal) 订阅。transcripts 是必需接入：对话正文由消息实体副本提供，不从观测记录生成。

initialize 并行取得配置和当前集合订阅的首帧基线。同一次进行中的初始化返回同一 Promise；失败不会永久缓存 rejected Promise，之后显式 initialize 会建立新尝试，不自动重试。配置与实体各自成功时分别保留已经确认的内容，后续尝试复用配置和健康实体连接；不能因为保留了部分配置就提前允许 submit。配置慢于实体流时，最终采用已经接纳的最新消息副本，不能把首帧旧内容覆盖到新增量之上。初始化结束前再次确认实体同步仍然有效。初始化不会请求执行概览、记忆或记录详情。

state.initialization 表达本次环境初始化的 idle、running、succeeded、failed 或 stopped；开始后携带本地 attempt 序号，failed 保留原错误。InitializationAttempt 只管理这个有限过程的状态与 Promise 结束权，不依赖服务端 Invocation，也不引入全局环境管理者。当前场景没有声明可恢复的业务异常，配置与同步失败直接结束本次尝试，不交给伪造的异常 handler。该状态只表示初始化结果，后续实体连接是否持续有效仍由 TranscriptState 表达。

stopTranscript 停止当前集合或全部集合时，也结束正在进行的初始化；已确认的配置和消息副本保留。旧尝试随后返回的配置被忽略，停止的实体连接回调也不能写入，新 initialize 可以明确建立下一次尝试。这不等于取消服务端工作，也不改变服务端 Initializer 的一次构造及失败缓存规则。

业务状态包含 messages、transcriptId、transcripts、busy、pending、contextId、answered 和 error。messages 只是当前集合已接纳 snapshot.messages 的便利引用；权威副本保存在按 UID 索引的 transcripts 中。

1. submit 设置 busy/pending，本实例忙碌时拒绝重复提交，不排队。
2. HTTP 接纳后清理 pending 并通知 accepted。接纳通知本身不追加消息；输入消息由独立实体流交付。HTTP 拒绝不追加、不刷新、不重试业务。
3. started 提供本次 Context ID、消息集合 UID 与输入索引，不依赖 Record ID；answer 提供同集合回答索引和完整 GenerationOutput。执行期间实体允许独立追加，因此回答索引只要求晚于输入，不要求紧邻。
4. answer 设置 answered 并检查集合身份；若该位置的实体内容已到达，也检查内容一致性。业务交付不再次追加回答，避免两个流的先后顺序导致重复；提交结束时再次核对实体中的正式回答，覆盖回答先到、实体后到的情况。消息流持续更新正文，answered 不代表所有后处理已结束。
5. completed 表示业务处理结束；error 表示业务失败。回答之后的记忆后处理失败不会清除已同步的回答。
6. 请求结束时，已同步到所需索引且连接正常的副本不再全量查询。连接未工作或尚未到达本轮末尾时，补取实体基线；补取不能让已接纳版本回退。业务失败与补取同时失败时，通过 AggregateError 保留两者，然后释放 busy/pending。

本轮交付完整回答，不实现 token/part、业务重试、恢复或多会话 UI。消息实体同步和业务完成是不同事实。

## 消息实体的按需加载与同步

```ts
await runtime.loadTranscript(transcriptId); // 首次获取原子基线，随后持续同步
runtime.stopTranscript(transcriptId); // 保留副本，停止这个集合的连接
await runtime.loadTranscript(transcriptId); // 建立新基线，不声称能重放离线增量
```

每个 TranscriptState 保存 snapshot、loading、syncing 和 error。snapshot 为 `{ id, revision, start: 0, end, starts, messages }`；revision 覆盖消息追加和分段变化。当前会话初始化时主动同步，只有被记录提及的其他集合默认不加载、不积压未订阅的增量。

GET /api/transcript/observe 首先交付 baseline，随后交付带完整消息正文的 TranscriptEvent。服务端在同步临界区内衔接快照和订阅；客户端不通过先 GET 再订阅推测这个接缝。GET /api/transcript 是明确的按需查询与补取接口。

TranscriptReplica 检查身份、revision 和范围：重复版本忽略，新增版本必须连续；追加必须从已知 end 开始；分段必须衔接已知 starts。接纳失败不部分修改旧副本。集合版本与观测交付 sequence 完全独立。

TranscriptReceiver 为已知 UID 复用订阅。默认集合与显式 UID 在首帧前并发订阅时，身份确认后合并连接，并正常兑现等待者。一次连接的顺序缺口、提前结束或网络断开最多自动重建一次基线；再次失败保留最后副本、停止同步并暴露错误。协议/远端拒绝不会被无限重试。显式重新加载可以再次建立基线；没有 replay、ACK、持久化或历史版本仓库。

快照查询与流增量可能交错：接收层只让较新或同版本的有效快照更新副本，旧响应不覆盖新状态。停止后的回调被忽略。stopTranscript 与 startObservation 返回的解除函数互不取消；观察停止不会停止消息同步或当前业务。

## 按需接入观测

```ts
const conversation = new ConversationHttpTransport();
const runtime = new ClientRuntime({
  conversation,
  transcripts: conversation,
  observation: new ObservationHttpTransport(),
});
await runtime.initialize();
const stopObservation = runtime.startObservation();
stopObservation(); // 只关闭观测连接
```

ObservationTransport 提供 overview、memory、execution、source、observe。仅传入此能力不会开始观测；startObservation 显式打开独立连接，由首帧一起取得概览、记忆与来源游标，不通过多个查询拼接基线，不预取已完成执行的全部详情。

观测基线中的消息是 `{ index, count }` 与 transcriptId，消息追加通知是 start/end；记忆来源是 `{ transcriptId, index }`。它们不携原文正文。Record 的调用输入输出和资源证据仍按各自契约保留，不能用于回填对话副本。

Runtime 的本地 subscribe 消费者逐个通知；抛错的消费者被移除，不阻断其他订阅者、已接纳的实体变化或后续源同步。这个隔离仅位于下游通知边界，不吞掉协议、版本或副本校验错误。

观测状态保存在 state.observation：enabled、loading、error、overview、memory、records、updates，以及 cursor、invocations、transcriptRecords。观测初始化或刷新失败只影响这个范围，不拒绝对话初始化或提交。

ObservationReplica 在新结构中整批接纳 delta，失败不部分修改已接纳状态。重复交付忽略，范围和顺序缺口拒绝。记录新增与父级引用同步接纳；过程仅追加新条目。资源事实作为独立 record entry 接收，按所属调用收集进 RuntimeSnapshot.resources；待调用记录和对应边界齐备后提供执行视图。客户端不从资源事实反推实际业务状态。

loadExecution 按需查询，终态缓存直接复用；查询期间收到更新时保留新快照。详情不进入 updates，不用历史详情覆盖概览。source 保留按需源码查询，不承诺执行时源码归档。

观测连接仅接受一个首帧基线。顺序缺口最多自动取得一次新基线，连续失败明确报错；普通断线不无限重连，refreshObservation 显式重建。旧连接回调和详情响应不得覆盖新连接。关闭观测不停止服务端记录。

## HTTP 包边界

HttpTransport 只处理地址、HTTP 状态、JSON 读取和错误，不感知业务、实体或记录。

- ConversationHttpTransport：config、POST /api/run、transcript 查询和 GET /api/transcript/observe。对话流检查开始、Context 与集合身份、回答位置和终态；实体流接纳 baseline/delta/error，不将断流当作业务完成。
- ObservationHttpTransport：overview、memory、execution、source 和 GET /api/observe。观测流可覆盖多次执行，结束不代表业务完成。
- 普通响应由 Zod 接纳；记录详情由 validateSnapshot 验证并核对请求身份；消息实体还由接收层检查范围与版本。

readLines 只负责 UTF-8 解码与行拆分。回调同步执行，失败后关闭 reader；HttpError 保留 HTTP 响应，ObserverTransportError 区分 contract / remote / delivery，网络异常保留原异常。取消实体或观测连接只解除对应交付。发送缓存有限，慢消费者断开后通过新基线接续，不承诺离线追赶。

## 应用绑定与 Store

- binding/application.ts 装配 Store 和命令，独立开启观测及对话初始化。卸载时分别停止观测和实体订阅；重新挂载恢复实体同步，保留已取得的配置与 UI 编辑。
- binding/data.ts 组织业务消息与进度，并组合可选观测。对话正文只来自消息实体副本。
- binding/observation.ts 按 UID/index 组合消息、上下文和记忆来源，明确区分未加载、加载中、缺失与错误；实体到达时即便记录未变化也重建对应读模型。
- binding/resources.ts 解释应用约定的配置与历史范围资源事实；details.ts 为各调用组织资源事实列表，React 不解析原始 RuntimeSnapshot。
- projectConversation 仅给当前同一消息集合中的已有消息添加执行链接，不能用相同 index 跨集合猜测关联。
- Store 保存应用读模型及草稿、预算、搜索、选择和弹层状态。组件持有局部 DOM、滚动和加载提示；未知原文提供加载入口，消息同步失败提供明确提示和重新连接入口。

对话仍用 Streamdown 静态渲染助手完整回答，用户输入保持纯文本；use-stick-to-bottom 处理滚动。消息图片只显示说明及显式链接，不自动加载外部资源。
