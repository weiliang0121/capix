---
'@weiliang0121/capix-runtime': minor
'@weiliang0121/capix-recording': minor
---

将自动记录观测安装拆为独立包。请从 `@weiliang0121/capix-recording` 导入 `bindRecording` 等记录预设，从 `@weiliang0121/capix-interaction` 导入交互实体。

Runner 的签名为 `new Runner(scene, resources, options?)`。从旧调用中删除第三位的 `interactions` 或 `undefined` 占位，将原第四位的配置移到第三位。原来只传了场景、资源与交互宿主的调用现在只传场景和资源。低层 CallableBuilder.build 与 CallableBinder.bind 同样将配置移到第三位。保留已通过普通资源供给的渠道。原 `resources.registerInteraction(offer, contract)` 登记改为 `resources.registerBinding(offer, () => interactions.bind(contract))` 按实际申请在构建时绑定。普通两参数运行继续可用。
