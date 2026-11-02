# 模型 Provider

`@capix/model-provider` 是可以从 `.mjs` 直接导入的模型通信包。当前提供 Chat Completions 的**非流式文本请求**，已用于 DeepSeek 意图识别实验；不依赖 Runtime、资源、Interaction 或 Observer。

```js
import { ChatCompletionsProvider } from '@capix/model-provider';

const model = new ChatCompletionsProvider({
  endpoint: 'https://api.deepseek.com/chat/completions',
  apiKey: process.env.DEEPSEEK_API_KEY,
  model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
  thinking: 'disabled',
});
const reply = await model.complete({
  messages: [{ role: 'user', content: '把 hello 翻译为中文。' }],
  maxTokens: 512,
});
if (reply.finishReason !== 'stop') throw new Error('模型未正常完成');
console.log(reply.text);
```

运行前在仓库执行 `pnpm build`。包不读取环境文件；配置由宿主传入。只有宿主显式执行以上调用才访问真实模型。

## 边界

- Provider 固定 endpoint/model/key/超时等配置，每次 `complete` 发起一次请求，无自动重试。它不持有会话、消息实体或交互引用。
- 返回 `text / finishReason / usage`，保留空文本和非 `stop` 结束。业务负责是否接纳、JSON 格式及意图契约；JSON 输出模式不能代替业务检查。
- 请求消息支持 system/user/assistant 文本。这是模型传输协议，不扩展正式 Transcript 的消息角色。提示词、历史、记忆和 Skill 如何组织由调用方决定。
- 总超时默认 60 秒，覆盖请求与响应读取；默认最多读取 2 MiB 响应，超限明确失败。显式 signal 取消保持原 reason；不会伪装为业务成功或重发请求。
- ProviderError 仅包含 code/message/可选 HTTP status，不保留上游错误正文、请求、headers 或底层异常。可注入 fetch 用于离线验证；自定义实现需遵守 Fetch 的取消语义。
- `thinking` 是明确可选的 DeepSeek 扩展；不向其他端点默认发送。其他兼容服务需要验证其协议，当前不承诺工具调用、多模态、SSE、所有厂商 SDK 的等效适配。

这是独立包的起点，Observer 既有业务 Provider 与流式链路保持现状。未来共享传输应另做等效迁移，不能把实验完成当成生产替换。

协议依据：[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)、[JSON Output](https://api-docs.deepseek.com/guides/json_mode/)。示例入口见 [意图识别实验](../../examples/intent/README.md)。
