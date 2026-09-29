# 客户端 Runtime

ClientRuntime 分别持有业务交付状态和可选观测状态，不依赖 React、HTTP 实现或服务端对象。两个接入接口都由 client/runtime 公开；client/http 的 ConversationHttpTransport 和 ObservationHttpTransport 分别实现它们，共用 HttpTransport 基类；应用通过 conversation / observation 具名参数决定接入哪些能力。

## 只使用对话

```ts
const runtime = new ClientRuntime({
  conversation: new ConversationHttpTransport(),
});
await runtime.initialize();
await runtime.submit({ messages: [{ role: 'user', content: '你好' }] });
```

ConversationTransport 只要求 config、transcript、run。initialize 只加载配置和消息，同实例合并重复初始化；不会请求概览、记忆、详情或订阅记录。getSnapshot / subscribe 提供当前状态与变化通知。

业务状态包含 messages、busy、pending、contextId、answered 和 error：

1. submit 设置 busy/pending，本实例忙碌时拒绝重复提交，不排队。
2. HTTP 接纳后追加已提交消息并清理 pending，通知 accepted；HTTP 拒绝不追加、不刷新、不重试。
3. started 提供本次 Context ID 和输入绝对索引，不依赖 Record ID；answer 提供正式回答的绝对索引和完整 GenerationOutput。
4. answer 到达即进入消息列表。answered 表示已经交付回答，不表示全部处理结束；当前固定串行追加要求回答索引紧接已知消息，错位明确报错并在结束时查询正式消息。
5. completed 表示整个处理结束；error 表示业务处理失败。回答之后发生的记忆后处理失败仍保留回答。
6. 接纳后的请求结束或异常后只等待消息刷新，再释放 busy/pending。刷新失败保留已交付消息。业务处理与消息刷新同时失败时通过 AggregateError 保留两者。

这轮交付完整回答，不实现 token/part 流、自动重试、重连、恢复、多会话或客户端执行实体。上下文身份只用于关联，同步版本与恢复游标仍未设计。

## 按需接入观测

```ts
const runtime = new ClientRuntime({
  conversation: new ConversationHttpTransport(),
  observation: new ObservationHttpTransport(),
});
await runtime.initialize();
const stopObservation = runtime.startObservation();
// 可以继续正常问答。
stopObservation(); // 只关闭观测连接，不取消正在执行的对话。
```

ObservationTransport 提供 overview、memory、execution、source、observe。仅传入此能力不会开始观测；startObservation 显式打开独立连接并加载概览、记忆，不预取全部详情。Observer 应用挂载时开启，卸载时关闭；未提供观测能力时此操作为空操作。

观测状态单独保存在 state.observation：enabled、loading、error、overview、memory、records、updates。观测初始化、订阅或刷新失败只影响这个范围，不拒绝对话初始化或提交，不写入对话错误提示。

records 保存收到的完整快照；updates 保存尚未由概览刷新接纳的流快照。观测仍采用完整执行快照，没有记录增量合并。终态快照触发观测刷新；业务请求结束也可触发观测刷新，但不等待它。概览刷新期间出现新快照时保留 updates；旧会话或旧刷新结果不得覆盖新观测。

loadExecution 按需读取，终态缓存直接复用；查询期间收到新流快照时保留新快照。详情不进入 updates，不用旧详情覆盖概览。source 保留按需源码查询，不承诺执行时源码归档。

观测订阅不具备历史重放：初始与后续查询补齐当前视图，不承诺跨接口同版本原子快照。没有自动重连或补发。关闭观测不停止服务端记录；服务端登记失败的现有运行规则不变。

## HTTP 包边界

HttpTransport 基类只处理地址、HTTP 状态、JSON 读取和错误，不感知业务或记录。两个子类直接继承该基类，彼此不依赖、不包含对方的方法：

- ConversationHttpTransport：config、transcript 查询，以及 POST /api/run 的接纳。ConversationUpdate 的 started / answer / completed / error；检查开始、身份、回答位置和结束顺序，不接受执行快照。
- ObservationHttpTransport：overview、memory、execution、source 查询，以及 GET /api/observe 的接纳。ObservationUpdate 的 snapshot / error；可包含多次执行，连接结束不代表业务结束。
- 普通查询：由 Zod 接纳配置、消息、概览、记忆和源码；记录详情由 validateSnapshot 接纳并核对请求 ID。

readLines 仅处理字节解码与行拆分。接收回调同步执行，失败后关闭 reader；HttpError 保留 HTTP 响应，ObserverTransportError 区分 contract / remote / delivery，网络异常保留原异常。关闭业务请求仍沿用服务端 AbortSignal 行为；关闭观测请求只解除记录订阅。

## 应用绑定与 Store

- binding/application.ts 装配 Store 与命令、订阅 Runtime、独立启动观测。
- binding/data.ts 组织业务消息和处理进度，并组合可选观测投影；对话正文只来自业务交付和 Transcript 查询。
- binding/observation.ts / overview.ts / details.ts 解释记录、整理轮次、过程、上下文与记忆关联，不创建对话消息。
- projectConversation 仅给已有消息增加可选执行定位链接，不能从执行记录补造助手回答。关闭观测时相同消息仍完整显示。
- Store 保存应用读模型与草稿、预算、搜索、选择和弹层状态，不持有原始记录。对话 notice 与 observationError 分开；观测错误在图谱区域展示。
- React 功能组件只订阅 Store、接收 props 和调用命令。DOM、滚动、输入法和单弹层加载提示保持局部状态。

组件仍使用 Streamdown 静态渲染助手完整回答，用户输入保持纯文本；use-stick-to-bottom 处理对话滚动。消息图片只显示说明及显式链接，不自动加载外部资源。
