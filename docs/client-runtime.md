# 客户端 Runtime

`@capix-observer/client-runtime` 从 Observer 页面抽离现有能力。ClientRuntime 持有一份客户端状态和执行快照缓存，并定义 ClientTransport 接口。独立的 `@capix-observer/client-http` 包提供通用基类 HttpTransport，以及继承它的业务类 ObserverHttpTransport。业务类实现当前 HTTP/NDJSON 契约，通过类型导入依赖客户端 Runtime 的接口。Runtime 不依赖 HTTP 实现；两个包均不依赖 React、DOM 元素或服务端运行对象。

```ts
import { ClientRuntime } from '@capix-observer/client-runtime';
import { ObserverHttpTransport } from '@capix-observer/client-http';

const runtime = new ClientRuntime(new ObserverHttpTransport('http://127.0.0.1:4320'));
const unsubscribe = runtime.subscribe(() => {
  const state = runtime.getSnapshot();
  console.log(state.busy, state.runningId, state.messages.length);
});
await runtime.initialize();
await runtime.submit({ messages: [{ role: 'user', content: '你好' }] });
unsubscribe();
```

浏览器同源部署时省略地址。ClientTransport 是查询与提交的接入边界，只由 client/runtime 公开；HttpTransport 与 ObserverHttpTransport 只由 client/http 公开，应用负责装配。测试可注入固定响应，不接入真实模型。运行时不默认创建全局单例；当前应用在 main.tsx 创建实例并传入 React。

## 持有与职责

| 内容                                           | 归属                  |
| ---------------------------------------------- | --------------------- |
| 初始化配置、消息、记忆、执行概览               | ClientRuntime         |
| 提交中状态、待接纳输入、关联执行 ID            | ClientRuntime         |
| 按需获取的快照、流中快照缓存及待刷新确认的更新 | ClientRuntime         |
| 记录解释、对话与上下文关联、搜索匹配、详情整理 | 应用 binding          |
| 已整理的 AppData 应用数据                      | App Store             |
| HTTP 请求、JSON 读取与状态错误                 | HttpTransport         |
| Observer 接口、响应接纳与记录流规则            | ObserverHttpTransport |
| 草稿、追加历史编辑、预算表单、提示文案         | App Store             |
| 当前查看轮次、搜索、密度、弹层                 | App Store             |
| DOM、滚动测量、输入法、详情加载提示            | React 组件            |

initialize 合并同实例的重复初始化调用。初始化只读取轻量概览，不批量获取全部执行快照。getSnapshot 返回当前状态引用，subscribe 在状态替换或缓存更新时通知；消费者按只读数据使用。取消订阅只停止通知，不取消服务端执行。

getExecution 读取缓存；loadExecution 按需查询，已缓存终态直接复用。流更新与详情查询使用同一缓存，较晚返回的查询不会覆盖查询期间收到的新快照。source 保留原有源码查询能力，不缓存源码，也不将其视为执行时的历史代码。

## 提交过程

1. submit 将 busy 置为 true，pending 保存待发送的末条输入，runningId 暂为空。同实例忙碌时拒绝再次提交，不排队。
2. HTTP 接纳后才把本次消息追加到已观测消息列表并清空 pending。可选 accepted 回调用于页面清空草稿；此时不承诺已经取得执行 ID。
3. 收到首条快照后写入 runningId；后续快照替换 records 缓存与 updates 中对应执行的引用，不在 Runtime 中生成概览或计算选择次数。绑定层负责解释这些记录。
4. 已接纳请求的记录流结束或异常后，刷新消息、记忆与执行概览，最后释放 busy。刷新失败仍保留已有快照，并向调用方抛错。

HTTP 拒绝不追加消息，不触发 accepted，不执行结束刷新。服务端执行 failed 是已观测的终态，正常结束的记录流不会因此抛出传输异常；调用方通过概览或完整快照读取失败事实。提前 EOF、非法流或网络错误会抛错，不把最后一条 running 快照改成成功或失败，也不自动重发。

这次没有新增客户端执行层级、提交记录实体、恢复状态机、取消、重连、持久化或多会话能力。错误和详情加载提示仍由使用方处理。UI 校验用于编辑提示，消息与配置的正式接纳仍由服务端负责。

## HTTP 包内部边界

HttpTransport 是抽象基类，提供 protected send/get/post；get 返回 unknown，不用泛型断言代替响应检查。基类只处理地址拼接、HTTP 请求、状态码与 JSON 读取，不包含 Observer 路径、业务对象或执行终态规则。子类可以覆写 statusError，解释各自服务的错误正文。

ObserverHttpTransport 实现 ClientTransport。配置、概览、消息、记忆与源码通过本包的 Zod 响应契约接纳；检查必要字段和类型，不做强制转换，不重复执行服务端业务规则，未知附加字段不进入已接纳结果。完整执行记录复用 protocol 的 validateSnapshot。详情查询校验请求 ID，源码查询校验路径。NDJSON 按字节解码与按行拆分由内部 readLines 函数负责；snapshot/error 的解释、执行身份和终态检查由业务类负责。终态之后再次出现快照会被拒绝。

错误保留以下区别：

- HttpError：response 保存 method/url/status，body 保存错误正文（包括非 JSON 文本），phase 区分 status/decode。Observer 子类额外保留服务端 code 与错误文本；JSON 解码失败保留 cause。
- ObserverTransportError：kind 为 contract、remote 或 delivery，分别表达协议接纳失败、服务端错误消息、调用方接收回调异常；code 与 cause 按实际错误保留。
- fetch 与 reader 的网络异常保留原异常，不包装成业务执行失败。

接收回调仍为同步接口。接纳通知失败会取消尚未读取的响应体；快照处理失败会关闭 reader 并释放锁，不继续交付，也不自动重试。服务端当前会在连接提前关闭时触发执行的 AbortSignal，因此本地交付失败仍可能影响远端执行；本次明确错误来源与清理路径，没有新增独立取消或恢复协议。

## 应用绑定与 Store

应用入口 `binding/application.ts` 的 createApplication 装配 Runtime、Store 与 commands。AppProvider 只管理 connect 的挂载和解除订阅，React 不再持有 Runtime 订阅入口。

```text
HTTP → Runtime 查询结果 / 记录缓存 / 请求状态
             ↓ subscribe
       binding 接收、解释、关联
             ↓ 一次提交
       Store 应用读模型 + 交互状态
             ↓ selector / props
       功能容器 → 展示组件

提交、读取详情、读取源码 → binding commands → Runtime
```

- `client/runtime/src/runtime.ts` 保留收到的 overview、messages、memory 和 records。updates 只引用尚未由成功的 overview/transcript 刷新确认的流记录；成功刷新一起清空，刷新失败则保留。按需详情进入 records，不进入 updates，避免旧详情覆盖新概览。这是本地已有观测恢复的边界，不是新增持久化或重连。
- `binding/overview.ts` 解释记录中的筛选、回答、记忆操作，合并流中概览。`binding/data.ts` 组织对话和轮次上下文；`binding/details.ts` 关联操作、子调用、过程引用和当时可见记忆。现有 `observation/` 纯投影函数由绑定层调用，不再由组件调用。
- `state/data.ts` 明确 AppData、RoundView、ExecutionDetail、CallDetail 等应用模型。Store 持有这些只读消费的数据以及交互状态，不持有原始 RuntimeSnapshot，不调用 Runtime。无需转换的协议正文可以保留引用，不深拷贝完整记录或建立第二份可修改的服务端事实。
- `binding/application.ts` 的 connectAppStore 订阅 Runtime，先完成转换再提交 Store；对搜索变化也在绑定层计算匹配结果。缓存更新不会重置预算或重建无关的轮次与对话数据；解除订阅后停止更新，再连接时可从现有 Runtime 缓存重新整理数据。初始预算、默认轮次和运行中跟随同样在绑定层应用。
- `binding/submit.ts` 读取表单、检查输入、调用 Runtime，HTTP 接纳后只清理尚未被用户重新编辑的已提交内容。异步错误进入应用提示。请求忙碌、接纳、执行关联与结束刷新仍由 Runtime 维护。
- 功能组件位于 `features/conversation`、`explorer`、`inspection`、`memory`、`settings`。功能容器订阅 Store，展示组件使用明确的 props；图谱坐标和视口属于功能内部，DOM、滚动、输入法、弹层 tab 与详情加载提示保留为本地状态。源码只通过 commands 按需取得，不作为运行时历史源码。

这轮是粗分层：保留已有协议和运行行为，未引入事件总线、通用绑定框架、Store 持久化、取消重试或新的恢复状态机。Trace 等旧投影内部结构、详情查询状态的进一步设计留待后续；当前原始记录的解释入口已收拢到绑定层。

## 对话呈现

应用内 `MessageContent` 使用 Streamdown 2.6.0 静态渲染助手完整回答，对话和问答详情复用；用户输入保持纯文本。支持 Markdown 列表、表格、链接和代码块，不执行消息中的 HTML，不补齐或动画播放正文。当前传输的是执行记录流，尚未提供回答 token 流。

对话滚动由 use-stick-to-bottom 1.1.6 观察内容高度：底部跟随、上翻脱离、点击“回到最新”恢复；提交新输入时回到底部。滚动状态留在组件，不写入 Runtime 或 App Store。没有迁入旧工程的展示时钟、parts 队列、锚点补偿或业务组件。

对话投影 `projectConversation` 合并 Transcript 消息与已观测的回答；未完成最终刷新时仍展示已有回答，不依赖 busy，不按正文相同判定重复，也不伪造消息索引。取得正式回答索引后直接复用正式消息。投影由绑定层执行，结果进入 Store 的 conversation；不写回 Transcript。

结束刷新将消息与执行关联一起接纳，记忆独立接纳；一组失败不会丢弃另一组成功结果。请求失败与刷新失败同时发生时通过 AggregateError 保留两者，单次失败保留原错误，最后释放本地 busy/pending，不重发请求。Markdown 图片仅显示说明与显式 HTTP(S) 链接，不自动加载外部资源，也不生成原生 title 提示。
