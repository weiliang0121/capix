---
'@weiliang0121/capix-changes': patch
'@weiliang0121/capix-contracts': patch
'@weiliang0121/capix-diagnostics': patch
'@weiliang0121/capix-invocation': patch
'@weiliang0121/capix-records': patch
---

CAPiX 自带错误的 `name` 在 Metro 等构建工具压缩类名后仍保持稳定，诊断继续使用原有错误名。应用自定义的派生错误仍沿用自身的类名。
