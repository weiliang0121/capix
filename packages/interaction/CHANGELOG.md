# @weiliang0121/capix-interaction

## 0.8.1

### Patch Changes

- cdca1c9: 更新包 README 中的安装命令、公开入口与用法说明，并在 npm 包中附带该包的 CHANGELOG.md，供离线查阅版本变化。
- Updated dependencies [cdca1c9]
  - @weiliang0121/capix-changes@0.7.1
  - @weiliang0121/capix-contracts@0.7.1
  - @weiliang0121/capix-diagnostics@0.7.1

## 0.8.0

### Minor Changes

- Add fixed independent request/reply UTF-16 text limits to interaction options and registrations. Defaults remain 16 Mi units per payload, with a supported maximum of 64 Mi units. Cold restoration uses the same limits and independently captures payloads, metadata and failure diagnostics, so accepted large exchanges remain readable after persistence. Structural budgets remain unchanged.
- Reject unknown feedback wrapper fields consistently during live reception and restoration; wrappers require exactly `id` and `payload`. Callers must pass the same intended limits when restoring; restoration reauthenticates data and never sends a request.
- Framework dependencies remain at 0.7.0. Consumers using Runtime interactions should use Runtime 0.7.1 to share this Interaction version; Tool recovery limit configuration requires Tool 0.11.0.

## 0.7.0

### Patch Changes

- @weiliang0121/capix-changes@0.7.0
  - @weiliang0121/capix-contracts@0.7.0
  - @weiliang0121/capix-diagnostics@0.7.0

## 0.6.0

### Patch Changes

- @weiliang0121/capix-changes@0.6.0
  - @weiliang0121/capix-contracts@0.6.0
  - @weiliang0121/capix-diagnostics@0.6.0

## 0.5.0

### Patch Changes

- @weiliang0121/capix-changes@0.5.0
  - @weiliang0121/capix-contracts@0.5.0
  - @weiliang0121/capix-diagnostics@0.5.0

## 0.4.0

### Patch Changes

- @weiliang0121/capix-changes@0.4.0
  - @weiliang0121/capix-contracts@0.4.0
  - @weiliang0121/capix-diagnostics@0.4.0

## 0.3.0

### Patch Changes

- @weiliang0121/capix-changes@0.3.0
  - @weiliang0121/capix-contracts@0.3.0
  - @weiliang0121/capix-diagnostics@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [972d478]
- Updated dependencies [8c25149]
  - @weiliang0121/capix-contracts@0.2.0
  - @weiliang0121/capix-changes@0.2.0
  - @weiliang0121/capix-diagnostics@0.2.0
