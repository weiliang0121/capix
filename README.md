# CAPiX

CAPiX 是可组合、可观测的 Agent 框架：用 Scene / Group / Node 组织处理逻辑，通过资源契约访问独立能力，由 Runner 建立每次调用并协调接纳、取消、输出和有限恢复。模型是可接入的资源能力之一；运行一个场景不需要启动 HTTP 服务。

当前公开包为 **0.x**，采用 [MIT](LICENSE) 许可。执行内核在 Node.js 上验证；目录统一为 `packages/` 不代表已支持浏览器或 Edge 执行。

## 第一个 Agent：整理便签

给助手两张便签，让它读取会议记录和项目计划，整理三项待办，再写成一张新便签。模型选择工具，普通节点处理操作，工具反馈进入下一次模型请求，直到给出最终回答。

从本仓库运行：

```sh
pnpm install --frozen-lockfile
pnpm build
node examples/notes-assistant.mjs
```

默认使用明确标识的离线决策脚本，工具执行和便签读写真实发生，不访问模型服务。便签保存在内存，程序结束后不落盘。接入真实模型的配置、完整源码和结果解读见[创建便签助手](docs/guide/getting-started.md)；框架为何划分这些职责，见 [Why CAPiX](docs/why.md)。Tool 尚未发布，当前示例以本仓源码为准。

## 更小的结构与资源例子

需要 Node.js **22.23.2** 或更新版本。在空目录中安装三个公开包：

```sh
npm init -y
npm install @weiliang0121/capix-resources @weiliang0121/capix-structure @weiliang0121/capix-runtime
```

保存以下内容为 `dictionary.mjs`，然后执行 `node dictionary.mjs`。例子使用内存字典，离线运行，不需要模型密钥或数据库。

```js
import { Node, Scene } from '@weiliang0121/capix-structure';
import { Resources, Runner } from '@weiliang0121/capix-runtime';
import { Resource, ResourceOffer } from '@weiliang0121/capix-resources';

const dictionary = new Resource(new Map([['hello', '你好']]));
const lookup = new ResourceOffer({
  methods: {
    translate(entries, word) {
      return entries.get(word) ?? word;
    },
  },
});
const translate = new Node({ deps: { dictionary: lookup.request() }, run: (work) => work.resources.dictionary.translate(work.input) });
const scene = new Scene(translate);
const runner = new Runner(scene, new Resources().register(dictionary, lookup)).build();
console.log(await runner.run('hello'));
```

预期输出：

```text
你好
```

同一用法在仓库内拆成 [dictionary.mjs](examples/dictionary.mjs) 和 [runner.mjs](examples/runner.mjs)。构建后可以运行 `node examples/runner.mjs`。

Scene 是入口结构，Group 组合成员，Node 执行具体处理；Resources 登记独立资源与其供给，`deps` 声明本阶段的访问需求。`build()` 固定结构和接线，每次 `run(input)` 才建立独立调用。外部请求和持久反馈可通过可选的 Interactions 接入，不是启动 Runner 的前提。

## 包与公开入口

18 个公开包纳入分发配置，统一使用 **`@weiliang0121/capix-`** 前缀，源码位于 `packages/<后缀>`，此前已发布包的 npm 名称保持不变；新增 `tool` 预设尚未发布。它们属于同一个 Changesets fixed 版本组；内部依赖从 `workspace:*` 转换成准确发布版本。新增候选能力不会自动加入该组。

| 包后缀                                        | 职责与入口                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| `contracts`、`protocol`                       | [进程内共同契约与真实跨端纯值](docs/contracts-protocol.md)                    |
| `resources`                                   | [资源声明、固定供给与受控访问](docs/resources-package.md)                     |
| `structure`、`runtime`                        | [Scene / Group / Node、绑定、Runner 与作者 Work](docs/callable-structures.md) |
| `invocation`                                  | [单次调用、关系、接纳与退出](docs/runtime-boundaries.md)                      |
| `checkpoint`                                  | [固定事实、Store 端口与显式有限恢复](docs/checkpoints.md)                     |
| `interaction`                                 | [独立外部请求、反馈及局部等待](docs/interactions.md)                          |
| `transcript`、`memory`、`view`、`measurement` | [消息、记忆、视图、使用计数及资源契约](docs/content-entities-packages.md)     |
| `records`、`changes`、`diagnostics`           | [可选记录、变化交付与故障诊断](docs/recording.md)                             |
| `tool`                                        | [原生工具调用的 Group 预设](packages/tool/README.md)                          |
| `model-provider`、`model-exchanges`           | [原生模型协议适配、回复与工具反馈实体](docs/native-tool-integration.md)       |

跨包只使用各包公开出口，不导入 `src` / `dist` 私有路径。Runtime 不转发所有能力；例如内容实体从各自包导入，可选记录安装使用 `@weiliang0121/capix-runtime/recording`。完整清单与分发验证见 [npm 发布](docs/npm-publishing.md)。

## 能力范围与版本边界

仓库当前维护结构、资源、调用、稳定值、有限 CP 恢复、交互、内容实体、记录、原生模型协议与 Tool 预设。当前主分支包含待发布契约；npm `0.1.0` 与本分支不能视为同一版本。使用已发布包时查看该版本的 README 和 CHANGELOG，消费本地候选时固定完整分发批次。

资源访问窗口约束框架内的受控操作，不提供操作系统隔离。MCP 接入、操作系统沙箱、动态调度与外部权限平台尚未作为框架能力实现。模型协议支持范围和预算以对应包契约为准。

CP 只恢复显式声明的 point 和完整依据，不恢复 JavaScript 栈、任意草稿或未知外部效果。取消会等待已经启动的子调用真实退出；保存、交付与外部效果分别成立，不构成统一事务。详情见[退出契约](docs/invocation-exit-contract.md)和[Checkpoint](docs/checkpoints.md)。

当前处于 0.x 开发阶段，公开契约和格式变化必须记录版本依据。只接收当前格式；不自动升级、清空或降级读取旧数据。拒绝旧数据不修改原文件，当前格式重启、交互读取和显式 CP 恢复仍是正式能力。

## 文档网站与示例

文档网站源码位于 `docs/`，公开示例位于 `examples/`；网站直接展示同一份可运行源码。框架不依赖其他仓库、服务或私人开发资料。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm docs:dev
```

`pnpm examples:check` 实际运行并验证示例；`pnpm docs:build` 校验文档链接与代码引用后构建静态网站，`pnpm docs:preview` 预览产物。文档站未自动部署。示例在 Node.js 执行，网站显示源码和运行说明，不表示执行内核可直接运行于浏览器。

学习路径见 [Why CAPiX](docs/why.md)、[创建便签助手](docs/guide/getting-started.md)、[示例](examples/README.md)与[架构](docs/organization.md)。自定义业务实体可以通过资源和 View 接入，不需要继承统一基类或把业务内容伪装成记忆；详见[自定义实体](docs/custom-entities.md)。

## 本地开发与贡献

仓库工具链固定为 Node **22.23.2**、pnpm **10.7.1**、TypeScript **6.0.3**，只有一个根 workspace 和锁文件。

```sh
pnpm install --frozen-lockfile
pnpm build
node examples/runner.mjs
pnpm check
```

普通检查不调用真实模型；首次安装依赖可能联网。发布产物另用 `pnpm release:check` 验证，它可能访问 registry，但不会发布 npm。GitHub 执行 CI 和版本 PR，npm 发布由维护者在本地明确执行。

贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)，漏洞报告边界见 [SECURITY.md](SECURITY.md)。[文档导航](docs/README.md) 组织学习路径与当前契约；[项目组织](docs/organization.md) 说明包边界与对象职责。
