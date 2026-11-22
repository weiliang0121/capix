# @weiliang0121/capix-recording

## 0.1.0

### Minor Changes

- e5adad3: 将自动记录观测安装拆为独立包。请从 `@weiliang0121/capix-recording` 导入 `bindRecording` 等记录预设，从 `@weiliang0121/capix-interaction` 导入交互实体。

  Runner 的签名为 `new Runner(scene, resources, options?)`。从旧调用中删除第三位的 `interactions` 或 `undefined` 占位，将原第四位的配置移到第三位。原来只传了场景、资源与交互宿主的调用现在只传场景和资源。低层 CallableBuilder.build 与 CallableBinder.bind 同样将配置移到第三位。保留已通过普通资源供给的渠道。原 `resources.registerInteraction(offer, contract)` 登记改为 `resources.registerBinding(offer, () => interactions.bind(contract))` 按实际申请在构建时绑定。普通两参数运行继续可用。

### Patch Changes

- Updated dependencies [e5adad3]
- Updated dependencies [e5adad3]
- Updated dependencies [e5adad3]
- Updated dependencies [e5adad3]
  - @weiliang0121/capix-contracts@0.8.0
  - @weiliang0121/capix-invocation@0.8.0
  - @weiliang0121/capix-records@0.7.2
  - @weiliang0121/capix-resources@0.8.0
  - @weiliang0121/capix-runtime@0.8.0
  - @weiliang0121/capix-structure@0.8.0
  - @weiliang0121/capix-changes@0.7.2

调用记录观测预设从 Runtime 拆出，沿用原有记录声明、安装与回执的含义。各版本的迁移说明由 Changesets 随版本生成。
