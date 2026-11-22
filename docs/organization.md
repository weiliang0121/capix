# 架构与包

CAPiX 是可组合、可观测的 Agent 框架。结构表达处理组织，资源提供受控操作，调用建立本次执行及事实，Runner 装配并驱动入口。模型是一种资源能力，框架不要求所有场景都遵循同一种模型循环。

## 作者首先使用的对象

| 对象                                 | 职责                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------- |
| Scene / Group / Node                 | 配置 deps/run/output/checkpoint；Scene 和 Group 组织成员，Node 直接处理 |
| Resource / ResourceOffer / Resources | 持有供给、声明操作、登记资源；绑定后按调用窗口提供端点                  |
| Runner                               | 固定场景与机制，build 接线，run 创建本次调用，resume 显式核验后恢复     |
| Interaction                          | 固定独立外部请求并持有反馈；局部等待不控制外部发送生命周期              |
| 实体 / View                          | 实体拥有内容及版本规则；View 保存所选来源和成员，读取本次固定材料       |

Scene、Group 和 Node 共同满足 callable 切面；组合能力来自成员契约，执行不需要针对每种结构创建另一套机制。结构实例在一棵树内唯一，业务函数与资源可以复用。build 不执行按次 capture、不创建 Invocation，也不创建第二棵可运行结构树。

## 调用与活动窗口

```text
结构配置 + 资源登记 + 可选机制
              ↓ build
          固定接线的 Runner
              ↓ run(input)
       Invocation / Context
              ↓ 当前阶段
      Work → 资源操作 / 子调用
              ↓
       接纳排空、关闭、最终交付
```

每次调用独立持有输入、信号和阶段窗口。子调用返回与父层接纳分开；取消请求停止，但入口须等已启动子调用真实退出才释放。外部 Interaction 可以继续存活，其反馈与流订阅通过准确资源操作接入。

固定值、正式交付、持久保存分别成立。CP 消费 Context／Relation 已成立的事实，不对活对象重新猜测历史；恢复只消费完整依据及显式声明的 point，不恢复任意 JavaScript 栈或外部效果。

## 包的所有者

全部框架源码在 `packages/`；公开包前缀为 `@weiliang0121/capix-`。表中名称省略该前缀。

| 包                       | 责任                                                        |
| ------------------------ | ----------------------------------------------------------- |
| platform / platform-node | 宿主 UUID、对象检查策略、数据运算与 Node 原生实现           |
| contracts                | 共同进程内端口、稳定值与唯一 RuntimeError                   |
| protocol                 | Transcript wire 的单帧编码形状与接纳，不持有传输或领域实体  |
| changes                  | 领域 FactType、捕获、同步发布与转交                         |
| resources                | Resource、Offer、Request、登记、绑定与访问窗口              |
| structure                | 可调用结构、成员、作者类型、Sequence/Dynamic                |
| invocation               | Context/Invocation、控制、关系、接纳、输出、关闭和调用侧 CP |
| checkpoint               | Frame v6、固定块、关系与选择认证、Store 契约及内存实现      |
| runtime                  | 结构构建与供给装配、Runner、Work 适配及观测安装端口         |
| interaction              | 请求、独立发送、反馈、等待与有界过程流                      |
| transcript / memory      | 正式消息与独立总结实体，各自写入、持久与资源契约            |
| view / measurement       | 通用来源与成员选择、准确消息身份的使用计数                  |
| recording                | 将 Runtime 观测事实写入 Records 的可选安装与解释策略        |
| records / diagnostics    | 记录实体与显式解释；持久故障身份及有界诊断                  |
| model-provider           | 模型正文、工具调用及原生续接的协议适配                      |
| model-exchanges          | 固定起点、完整模型回复、工具反馈槽与固定接纳凭据            |
| tool                     | 使用公开结构、资源与交互的普通 Group 工具预设               |

结构、资源、调用和实体不反向依赖 Runtime；调用不依赖结构实现。实体不依赖 protocol，记录的默认内容解释消费实体公开事实类型。Tool 不依赖 Runtime 实现。准确依赖由每个 package.json 声明，并由仓库检查验证。

共同类型按实际跨包责任晋级 contracts；可序列化数据也未必是跨端协议，例如 Frame 属于 checkpoint。Message、Memory 和记录数据仍从其领域包公开出口获取，不通过 protocol 汇总。参见[契约与协议](contracts-protocol.md)。

## 执行与外围装配

单独安装 `capix-runtime` 的生产依赖范围含十个 CAPiX 包：runtime、structure、resources、invocation、checkpoint、contracts、changes、diagnostics、platform 和 platform-node。无模型、记录或外部交互的 Scene 可在这组安装中直接执行。发布验证使用这些包的实际 tarball，从只声明 Runtime 的仓外消费者运行一次 Scene。

宿主通过 Runner 的 `observations` 安装观测消费者。`capix-recording` 同时依赖公开观测端口和记录实体；已有应用应从新包导入 `bindRecording`。宿主按需使用 `capix-interaction`，通过 `resources.registerBinding(offer, () => interactions.bind(contract))` 把渠道提供给实际声明该 Offer 的结构。两参数 `new Runner(scene, resources)` 适用于普通运行。已有四参数调用把最后的选项移到第三位。

执行机制继续掌握真实关系、接纳、取消和排空。Checkpoint 的固定值检查也用于未安装 Store 的普通调用，当前 Invocation 与 Runtime 仍依赖具体 Checkpoint 实现。新的宿主实现需要分别证明构造期身份、对象接纳及异步来源，并保持已登记 Offer 的对象身份。

`capix-platform` 负责宿主身份、对象检查策略和通用数据运算，`capix-platform-node` 提供 Node 原生能力。Node 自动使用原生检查。无法提供原生检查的 Hermes 等宿主可在启动时调用 `useAuthorProvidedPlainObjects()`，由作者保证 CAPiX 检查的对象及其嵌套内容和原型链没有 Proxy 或 JSI `HostObject`。Expo 应用可以用 `installRandomUUID` 提供标识生成函数。宿主设置在导入业务模块前完成。[平台启动示例](../packages/platform/README.md#ios-hermes-启动)

## 实体与资源的组合

实体可以由作者实现，不需要统一 Entity 基类或统一内容状态。固定读取、版本核验、条件更新、历史查询和持久确认是分别兑现的能力；没有实现历史读取，就不能仅凭版本号承诺旧正文可找回。

资源负责操作接口与窗口，不替实体解释业务内容。View 组织来源和成员，不管理实体生命周期。Memory 是总结实体，不要求业务事实都编码成记忆；具体材料选择、提取和压缩由结构与资源组合。

记录属于可选消费。领域事实通过准确资源操作建立来源关联，不等于证明该操作造成所有变化，也不替代恢复依据。完整说明见[实体](content-entities-packages.md)、[自定义实体](custom-entities.md)与[记录](recording.md)。

## 运行环境与验证

Node.js 是完整 Runner 的基准环境。其他宿主按公开入口和启动配置分别验证。独立资源包通过 ESM 条件选择 UUID 实现，默认条件使用宿主的 Web Crypto。子调用的普通接纳与排空可以脱离 Node 的异步上下文，固定实体操作可以显式传入子结果接纳回调的凭据，在窗口内跨 `await` 核对父子身份。结构构建、View 捕获和模型请求等边界依据宿主检查策略处理对象。标准 Hermes 在配置检查策略前，遇到需要宿主判定的对象会拒绝。[运行边界](runtime-boundaries.md#宿主对象检查)和[严格对象检查实验](../scripts/platform/README.md)说明了接纳责任和验证范围。

只检出本仓即可构建、测试与验证分发。测试随责任包，组合测试归真实协调者，文档使用同一份可执行示例；详见[测试](testing-organization-design.md)。取消、恢复、资源权限和外部效果的边界不能因示例简化而扩大。
