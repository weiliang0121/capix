# @weiliang0121/capix-resources

为 CAPiX 提供资源定义、登记、固定接线和有生命周期的受控访问。

## 安装与入口

运行环境为 Node.js `>=22.23.2`。包使用 ESM，附带 TypeScript 类型声明。

独立资源包也可以由支持 ESM 条件解析的宿主加载。Node 条件使用内置 UUID 生成器，默认条件使用宿主的 `globalThis.crypto.randomUUID()`。宿主应在创建第一个 `ResourceOffer` 前提供该方法；资源声明、供给和每次操作分别生成身份。

```sh
npm install @weiliang0121/capix-resources
```

- `@weiliang0121/capix-resources` 提供 `Resource`、`ResourceOffer`、独立使用的 `Resources`，以及申请、绑定、供给和访问端口。
- `@weiliang0121/capix-resources/operation` 提供 `receiveOperation` 与操作结果、接收选项等类型，供资源访问和宿主子调用共用。

## 用法

独立使用时，从 `@weiliang0121/capix-resources` 导入 `Resource`、`ResourceOffer` 和 `Resources`。用 `register(resource, offer)` 登记实体和操作，再用 `bind({ dictionary: offer.request() })` 固定接线。每次 `binding.open()` 建立独立的访问窗口，通过 `access.endpoints` 调用业务方法，并在操作完成后调用 `access.close()`。[独立资源访问示例](https://github.com/weiliang0121/capix/blob/main/docs/resources-package.md#独立使用)

接入场景时，从 `@weiliang0121/capix-runtime` 导入 `Runner` 和它所需的 `Resources`。继续从本包导入 `Resource` 和 `ResourceOffer`。结构用 `deps` 申请资源，业务通过 `work.resources` 取得本次调用的端点。[字典资源工厂](https://github.com/weiliang0121/capix/blob/main/examples/dictionary.mjs)

## 契约与版本记录

- [登记、接线与访问窗口](https://github.com/weiliang0121/capix/blob/main/docs/resources-package.md)
- [资源声明及子树供给](https://github.com/weiliang0121/capix/blob/main/docs/concepts/resources.md)
- [按版本查阅 CHANGELOG](https://github.com/weiliang0121/capix/blob/main/packages/resources/CHANGELOG.md)
- [MIT 许可证](LICENSE)
