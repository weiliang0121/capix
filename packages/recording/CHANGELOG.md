# @weiliang0121/capix-recording

## 0.1.0

### Minor Changes

- e5adad3: 从 Runtime 拆出记录观测预设。原根入口和 recording 子路径下的 `bindRecording` 等导入改为 `@weiliang0121/capix-recording`。在 Runner 的 `observations` 配置中显式安装预设。Runner 配置的位置与资源绑定迁移见 [Runtime 变更记录](https://github.com/weiliang0121/capix/blob/main/packages/runtime/CHANGELOG.md)。

### Patch Changes

- Updated dependencies [e5adad3]
  - @weiliang0121/capix-contracts@0.8.0
  - @weiliang0121/capix-invocation@0.8.0
  - @weiliang0121/capix-records@0.7.2
  - @weiliang0121/capix-resources@0.8.0
  - @weiliang0121/capix-runtime@0.8.0
  - @weiliang0121/capix-structure@0.8.0
  - @weiliang0121/capix-changes@0.7.2

调用记录观测预设从 Runtime 拆出，沿用原有记录声明、安装与回执的含义。各版本的迁移说明由 Changesets 随版本生成。
