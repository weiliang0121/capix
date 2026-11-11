# Checkpoint 的增量引用选择

增量选择避免作者每次重新提交完整 `refs` 数组。Context／Relation 仍持有已经成立的调用事实；选择只表达作者打算在恢复点使用哪些孩子，不决定哪些孩子属于事实，也不扩大恢复范围。

## 作者写法

```ts
const selected = work.checkpoint.select(node);

const call = work.children.create(node, input);
const occurrence = selected.add(call.ref);
work.checkpoint({ point: waiting, state, refs: { children: selected } });

await call.invoke();
work.checkpoint({ point: received, state: nextState, refs: { children: selected } });

// 只移除这一次出现；关系、返回和接纳事实都仍保留。
selected.remove(occurrence);
```

`select` 属于本次调用的 checkpoint 写端口。创建选择不写入存储，`add` / `remove` 改变待保存的选择；准确保存回执到达后，内部才推进已提交依据。没有安装 CP 时没有这个端口，普通业务仍可使用自己的数组。

同一选择可以显式传给多个兼容恢复点；恢复点不会隐式继承上一个点的槽位。每次保存仍核对槽位名、one/many 和固定子声明位置。不同调用的选择、不同声明的孩子、伪造的出现项都不能混用。

原来的单引用不变。many 接受两种有不同含义的输入：

| 写法                           | 含义                   | 提交成本                 |
| ------------------------------ | ---------------------- | ------------------------ |
| `refs: { children: [a, b] }`   | 完整替换当前选择       | 按完整数组处理           |
| `refs: { children: selected }` | 使用这份选择的当前版本 | 按新增、移除的出现项处理 |

这是有序列表，重复的孩子引用有各自的出现项凭据。`add` 追加并返回凭据；`occurrenceAt(index)` 可取得已有项凭据；`remove` 只删指定项。首版不增加任意插入或排序方法，需要整体改序时显式给出完整数组。

## 恢复与查询

```ts
resume: {
  uses: [node],
  async run(work, state, saved) {
    const selected = work.checkpoint.select(node, saved.children);
    const first = selected.occurrenceAt(0);
    if (first) selected.remove(first);

    const child = work.children.create(node, nextInput);
    selected.add(child.ref);
    work.checkpoint({ point: waiting, state, refs: { children: selected } });
    return child.invoke();
  },
}
```

`saved.children` 保持只读数组接口。它携带本次恢复的准确选择依据，`select(node, saved.children)` 据此接续原选择。传入自己复制或新构造的数组表示首次导入，不根据正文相等猜测选择身份。

`point.check` 中的 many 也是只读数组查询接口：`length`、索引和 `at(-1)` 按实际访问取值，不因为只读最后一项而构造全部事实。遍历、`map`、`find` 等仍承担相应读取成本。查询仅在本次同步 check 内有效；已取出的稳定事实值仍可保留。恢复数组的访问受恢复 Work 窗口约束。

当前有序选择以链表维护出现项：首尾访问为 O(1)，顺序访问合计 O(R)，任意位置跳转最坏 O(R)。这不是一个承诺任意随机下标 O(1) 的持久向量；收益来自保存时无需读取旧项，以及常见的末项查询不扫描历史。

## 持久边界

物理保存分别表达：当前 head 选用了哪些选择版本、这次哪些出现项新增或移除。每个出现项保留独立身份、追加顺序及准确孩子引用；删除不会删除孩子关系。完整数组替换沿用完整处理路径。

选择变化与 CP head 使用同一 Store 提交和 revision 比较。对新增项核验真实父子身份、round、order 和固定声明位置；删除核对准确出现身份、顺序及原引用。提交失败或回执不确定不冒充已成功推进。选择并不提供资源效果或跨实体事务。

冷读取完整重建逻辑 `references`，重新检查选择汇总、出现项、关系及容量；可序列化的恢复依据不以进程内对象身份作为信任来源。逻辑 Frame v6 的全部关系与 refs 语义保持不变，8 MiB／值节点／深度限额仍按逻辑出现次数计费，不以紧凑物理表示放宽。

Store 必须将选择和出现项与 head 一起保存。删除的出现项保留身份与顺序墓碑以拒绝复用；未被当前 head 选择的已发布集合仍可在同进程稍后显式重选。冷恢复只取得当前 head 选中的集合，不恢复业务闭包中其他选择句柄；核验选中集合时仍检查其历史墓碑。终态不自动退休这些行，不承诺总存量或冷读取成本恒定。

## 收益的边界

- 热保存不再为未变化的累计选择重新编码全部引用。
- 同一选择跨兼容恢复点使用，不重新复制历史。
- `state` 仍按作者提交的完整内容编码；`point.check` 仍每次执行。
- 作者全量遍历、冷恢复、完整数组替换仍是全量工作。
- 选择和关系的总存量仍随实际历史增长。没有加入自动分段、隐式退休或 continue-as-new。

Tool 使用增量选择保存模型和工具引用，原有业务检查与恢复核对保留。因此减少 refs 提交不等于其所有历史检查都已增量化。

## 验证入口

[Store 选择测试](../packages/checkpoint/test/selection-store.test.mjs) 覆盖出现项、墓碑、归属、逻辑限额和冷读取；[调用增量选择测试](../packages/invocation/test/checkpoint-incremental-selections.test.mjs) 覆盖作者端口、准确恢复选择、跨点显式选择和查询成本。[Tool 恢复测试](../packages/tool/test/recovery.test.mjs) 验证预设在新 Runner 和 Store 中恢复及缺失依据拒绝。普通测试不请求真实模型。
