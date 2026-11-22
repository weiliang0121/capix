# @weiliang0121/capix-platform

提供 CAPiX 各包共享的宿主身份、对象检查和数据运算入口。Node.js `>=22.23.2` 自动使用 Node 原生能力。其他宿主由入口条件选择默认分支。

```sh
npm install @weiliang0121/capix-platform
```

- `@weiliang0121/capix-platform` 提供启动时使用的 `installRandomUUID`、`installObjectInspection`、`useAuthorProvidedPlainObjects` 和宿主契约类型。
- `@weiliang0121/capix-platform/identity` 为声明、调用及操作生成 v4 UUID。默认使用宿主 Web Crypto。也可以在创建首个 CAPiX 身份之前安装宿主 UUID 函数。
- `@weiliang0121/capix-platform/inspection` 提供 Error、Promise 和不适合反射的对象的判定，具体能力由宿主检查策略提供。
- `@weiliang0121/capix-platform/bytes` 负责 UTF-8 字节预算、编码和 Base64 解码。
- `@weiliang0121/capix-platform/hash` 提供可复制中间状态的同步 SHA-256。
- `@weiliang0121/capix-platform/equal` 用于固定数据比对。Node 条件沿用原生深比较，默认条件对普通无环数据检查原型和数据属性。

## 对象检查策略

- 原生检查。Node 自动使用 `node:util.types` 的原生检查，`useAuthorProvidedPlainObjects()` 不会覆盖它。其他宿主可以调用 `installObjectInspection` 安装引擎判定，它必须准确识别不适合反射的对象、原生 Error 和 Promise，且不读取输入属性、触发代理 trap 或宿主回调、修改对象。
- 作者保证。缺少原生检查的宿主可显式调用 `useAuthorProvidedPlainObjects()`。作者保证 CAPiX 将检查的对象、嵌套内容和相关原型链均无 Proxy 或 JSI `HostObject`。结构、端点和函数经明确支持的能力端口进入。普通数据仍要符合各入口的字段、原型、数组、循环及预算规则。混入 Proxy 或宿主对象可能在读取元数据时执行 trap 或宿主回调，也可能使检查接纳伪装值或抛错。

缺少原生检查的宿主在配置策略前会拒绝需要宿主对象判定的输入。启动配置应先于任何会用到这些能力的导入。CAPiX 包在同一个 JS 环境中应解析到同一份 `capix-platform` 模块实例。选定检查策略后即固定。[运行边界](https://github.com/weiliang0121/capix/blob/main/docs/runtime-boundaries.md#宿主对象检查)

## iOS Hermes 启动

在使用 Hermes 的 Expo 应用中，通过 `npx expo install expo-crypto` 安装 UUID 提供方。使用支持并启用了 `package.json` 的 `exports` 和 `imports` 的 Metro 版本。按 React Native 的条件解析包，CAPiX 此时使用 `default` 分支。[Metro 模块解析](https://metrobundler.dev/docs/resolution/)

对于使用自定义入口的应用，可将 `package.json` 的 `main` 指向下面的 `index.js`。在 `App` 模块中导入所需的 CAPiX 包并默认导出根组件。入口先配置平台，再通过动态导入加载 `App`，这样模块顶层创建 ResourceOffer 时已有 UUID 生成器。[Expo Crypto](https://docs.expo.dev/versions/latest/sdk/crypto/#cryptorandomuuid)、[Expo 自定义入口](https://docs.expo.dev/versions/latest/sdk/expo/#registerrootcomponent)

```js
import { registerRootComponent } from 'expo';
import { randomUUID } from 'expo-crypto';
import { createElement, lazy, Suspense } from 'react';
import { installRandomUUID, useAuthorProvidedPlainObjects } from '@weiliang0121/capix-platform';

useAuthorProvidedPlainObjects();
installRandomUUID(randomUUID);

const App = lazy(() => import('./App'));

registerRootComponent(function Root() {
  return createElement(Suspense, { fallback: null }, createElement(App));
});
```
