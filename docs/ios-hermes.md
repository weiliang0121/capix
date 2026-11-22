# 在 iOS Hermes 中接入 CAPiX

在标准 React Native / Expo iOS App 中，界面和 Runner 可以在同一个 Hermes 运行时执行。下面的接入方式适用于应用掌控 CAPiX 输入的场景。[通用宿主契约](host-platforms.md)

## 启动顺序

1. 安装应用实际使用的 CAPiX 包与 `@weiliang0121/capix-platform`，用 `npx expo install expo-crypto` 安装 UUID 提供方。Metro 需支持包的 `exports` 和包内 `imports`，使用 iOS 的正常解析条件，使 CAPiX 进入 `default` 分支。
2. 在入口的启动模块中，从 `@weiliang0121/capix-platform` 导入 `useAuthorProvidedPlainObjects`、`installRandomUUID`，从 `expo-crypto` 导入 `randomUUID`。依次调用 `useAuthorProvidedPlainObjects()` 和 `installRandomUUID(randomUUID)`。
3. 完成配置后再加载会声明 Offer、创建结构或检查输入的业务模块。可以在配置后动态导入业务入口，或让独立的启动模块成为入口的首个副作用导入。包与业务代码应共享同一份平台模块实例。

标准 Hermes 缺少适合这里使用的严格 Proxy 判定。采用上述策略的应用负责排除受检查对象、嵌套值和原型链中的 Proxy 与 JSI `HostObject`。例如，由应用解析服务端的 JSON 并校验字段后再交给 Runner，将原生文件句柄保留在读取附件的资源操作里。可对照实验入口的真实加载顺序接线。[实验入口](../scripts/platform/README.md#public-feature-matrix) · [Expo Crypto](https://docs.expo.dev/versions/latest/sdk/crypto/#cryptorandomuuid)

## 流式模型请求

从 `expo/fetch` 导入 `fetch`，将它作为 Provider 配置中的 `fetch` 字段传入。接纳增量文本和完整回复都依赖正确的响应流。在本地 HTTP 夹具中应分别核对正文是否逐段到达、最终状态、实际请求次数，以及取消后已启动请求能否退出。[Provider 传输选项](../packages/model-provider/README.md) · [Expo Fetch](https://docs.expo.dev/versions/latest/sdk/expo/#expofetch-api)

## 用 Release App 验收

使用 Xcode 安装标准 iOS Release 构建，在 App 中运行公开功能样本。固定实体写入使用子结果回调提供的接纳凭据。需要保存设备数据时，接入产品使用的 Store，分别测试首次提交、重开和显式恢复。已测模拟器、能力范围与可复现的测试材料见[宿主验证范围](host-platforms.md#验证范围)与[实验记录](../scripts/platform/README.md#release-app-results)。
