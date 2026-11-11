# 实体与视图

实体拥有内容和版本规则；View 只组织本次使用的成员。成员退出不删除来源内容，已经捕获的快照保持原值。

先执行 `pnpm build`，再执行下列命令。所有示例均在本机 Node.js 中运行。

## entities

```sh
node examples/entities.mjs
```

<<< ../../examples/entities.mjs{js}

## view

```sh
node examples/view.mjs
```

<<< ../../examples/view.mjs{js}

## view-membership

```sh
node examples/view-membership.mjs
```

<<< ../../examples/view-membership.mjs{js}

## 示例业务对象

<<< ../../examples/entities/domain.mjs{js}

## 静态 Skill 来源

<<< ../../examples/view/skills.mjs{js}
