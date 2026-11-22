# @weiliang0121/capix-platform

## 0.1.0

### Minor Changes

- e5adad3: 新增平台入口，提供 UUID、对象检查、UTF-8 与 Base64、SHA-256 和固定数据比较。宿主可在首次分配身份前通过 `installRandomUUID` 提供安全 UUID。缺少原生对象判定时，可安装检查适配器，也可通过 `useAuthorProvidedPlainObjects()` 承担输入及其原型链无 Proxy 或 JSI HostObject 的义务。[宿主能力与验证范围](https://github.com/weiliang0121/capix/blob/main/docs/host-platforms.md)

### Patch Changes

- Updated dependencies [e5adad3]
  - @weiliang0121/capix-platform-node@0.1.0

首次引入平台入口，各版本由 Changesets 独立记录。
