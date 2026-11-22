# @weiliang0121/capix-interaction

Interaction 固定一次独立发送的请求与反馈，支持持久化、局部等待和可选的有界过程流。

## 安装与入口

包使用 ESM，附带 TypeScript 类型声明。完整回归在 Node.js 22.23.2 上运行，支持范围为 Node.js `>=22.23.2`。其他 JavaScript 宿主按使用的入口配置所需能力。[宿主能力与验证范围](https://github.com/weiliang0121/capix/blob/main/docs/host-platforms.md)

```sh
npm install @weiliang0121/capix-interaction
```

- `@weiliang0121/capix-interaction` 提供 `Interaction` 实体、Interactions 登记、持久化与过程反馈契约。

## 用法

```js
import { Interactions } from '@weiliang0121/capix-interaction';

const contract = { key: 'example.echo.v1', request: String, reply: String };
const interactions = new Interactions().register(contract, { send: (request) => request });
const channel = interactions.bind(contract);
const reference = channel.start('你好');
const result = await channel.wait(reference, { waitMs: 1000 });
if (result.kind === 'received') console.log(result.feedback.payload);
```

等待到期返回 `wait-expired`。signal 中止时，等待的 Promise 以 `signal.reason` 拒绝。两种情况下发送者仍可保存反馈。宿主可用 `await interactions.settled()` 等待已启动的发送收尾。

## 数据预算与恢复

`InteractionOptions.limits` 和 `InteractionRegistration.limits` 独立设置 `requestTextUnits`、`replyTextUnits`。契约转换前后分别检查对应正文。每项默认 `DEFAULT_INTERACTION_TEXT_UNITS`（16 × 1024²），可设为不超过 `MAX_INTERACTION_TEXT_UNITS`（64 × 1024²）的正安全整数。文本按 JavaScript `string.length` 计 UTF-16 代码单元，包含字符串值和对象键。请求与反馈分别计费，因此各含 9 Mi 代码单元的请求与反馈可使用默认预算恢复。

构造或登记时复制并固定预算。状态不保存原预算。`Interaction.restore(state, { contract, limits })` 按宿主此次提供的预算（省略时取默认值）重新捕获，并核对契约转换后与原材料等价。按登记引用读取时复用该登记固定的预算。恢复只生成只读实体，不写入或重发请求。

请求、反馈正文、状态元数据、反馈元数据及失败诊断分别捕获。各域限深度 64、最多访问 100,000 个值；元数据与诊断使用默认文本预算。只接纳被动 JSON 形状的数据，拒绝 getter、不可枚举属性、Symbol 属性、稀疏数组、循环及不支持的对象。状态与反馈外壳拒绝额外字段，反馈要求准确的 `id` 与 `payload`。原生检查拒绝 Proxy，采用作者保证模式时由宿主提供无代理的数据。[宿主对象检查](https://github.com/weiliang0121/capix/blob/main/docs/runtime-boundaries.md#宿主对象检查)

直接调用 `receive` 时，反馈校验失败会抛错，保留原已提交状态。`start` 的发送者抛错或返回未通过校验的反馈时，若尚无已接纳反馈，会尝试提交失败诊断；成功提交后读取结果为 `unavailable`。提交本身失败时报告持久化故障，保留最后已确认版本。

## 契约与版本记录

- [交互、等待与恢复契约](https://github.com/weiliang0121/capix/blob/main/docs/interactions.md)
- [按版本查阅 CHANGELOG](https://github.com/weiliang0121/capix/blob/main/packages/interaction/CHANGELOG.md)
- [MIT 许可证](LICENSE)
