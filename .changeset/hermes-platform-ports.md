---
'@weiliang0121/capix-platform': minor
'@weiliang0121/capix-platform-node': minor
'@weiliang0121/capix-contracts': minor
'@weiliang0121/capix-checkpoint': patch
'@weiliang0121/capix-diagnostics': patch
'@weiliang0121/capix-interaction': patch
'@weiliang0121/capix-invocation': minor
'@weiliang0121/capix-memory': patch
'@weiliang0121/capix-model-exchanges': minor
'@weiliang0121/capix-model-provider': patch
'@weiliang0121/capix-records': patch
'@weiliang0121/capix-resources': minor
'@weiliang0121/capix-runtime': minor
'@weiliang0121/capix-structure': minor
'@weiliang0121/capix-tool': patch
'@weiliang0121/capix-transcript': minor
'@weiliang0121/capix-view': patch
---

身份、对象检查、同步哈希、字节编码及固定数据比较分别通过平台入口提供。Node 自动选择原生检查。缺少原生检查的宿主可在启动时安装引擎检查能力，或调用 `useAuthorProvidedPlainObjects()`，由作者保证 CAPiX 检查的对象、嵌套内容和相关原型链没有 Proxy 或 JSI `HostObject`。调用该函数不会覆盖 Node 的检查。标准 Hermes 未配置策略时会拒绝需要宿主对象判定的输入。应用可用 `installRandomUUID` 提供 UUID，并在配置完成后动态导入业务模块。

子结果接纳回调新增仅在该次接纳期间有效的来源凭据。宿主在跨异步等待写入固定实体时，可将凭据传给对应操作。Tool 预设会在自己的固定写入中使用该凭据。Node 上仍支持原有隐式接纳。只声明一个形参的回调可以沿用。将内置函数或会解释额外实参的函数直接用作接纳回调时，请用单参数箭头函数包装。
