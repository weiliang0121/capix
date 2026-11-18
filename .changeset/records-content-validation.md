---
'@weiliang0121/capix-records': patch
---

修复执行记录子树快照对内容记录校验不足的问题。读取 Transcript 记录时检查来源、修订号、发生时间和变更范围，读取 Memory 记录时检查条目和集合身份、序号与可选操作身份。
