const kib = (value) => (value / 1024).toFixed(1);
const mib = (value) => (value / 1024 / 1024).toFixed(2);

export function renderReport(summary, rows) {
  const milestones = rows.filter((row) => summary.checkpoints.includes(row.number));
  const phases = Object.values(summary.phases);
  const reported = phases.reduce((total, phase) => total + phase.usageReportedRequests, 0);
  const requests = phases.reduce((total, phase) => total + phase.requests, 0);
  const inputTokens = phases.reduce((total, phase) => total + (phase.promptTokens ?? 0), 0);
  const outputTokens = phases.reduce((total, phase) => total + (phase.completionTokens ?? 0), 0);
  const totalTokens = inputTokens + outputTokens;
  const memoryTokens = (summary.phases.memory?.promptTokens ?? 0) + (summary.phases.memory?.completionTokens ?? 0);
  const lines = [
    '# 多主题长对话验证',
    '',
    `模式：${summary.mode}；完成 ${summary.completed}/${summary.planned} 次提交；ModelProvider.complete 调用 ${summary.modelCalls} 次（不等同于实际 HTTP 发送数）。`,
    '',
    summary.mode === 'offline' ? '本报告使用固定模型替身。只验证真实服务链路和本样本的数据增长，不评价语义质量或真实模型性能。' : '本报告保留真实回答及记忆变化；语义评估仍需对照 review.md 人工核对，没有自动判为正确。',
    '',
    '| 提交数 | 回答请求 JSON KiB | 提取请求 JSON KiB | 累计 CP image 原 JSON MiB | 本次最大原 image KiB | 正式消息 / 记忆 / 活跃项 |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
    ...milestones.map((row) => `| ${row.number} | ${kib(row.requests.find((request) => request.phase === 'answer')?.jsonBytes ?? 0)} | ${kib(row.requests.find((request) => request.phase === 'memory')?.jsonBytes ?? 0)} | ${mib(row.checkpoints.totalImageBytes)} | ${kib(row.checkpoints.maxImageBytes)} | ${row.content.messages} / ${row.content.memories} / ${row.content.members} |`),
    '',
    '逐次请求的 ModelRequest JSON 字节、prompt 文本字节、真实 HTTP 请求正文（仅 live）、usage、首片段/完成耗时、正式内容及记忆快照保存在 events.jsonl。JSON 字节不能当作 token 数或含协议头的网络流量。',
    '',
    '调用侧 CP 计量仍累计保存成功的原 image JSON；压缩或淘汰旧正文不表示这些材料的构造、校验和序列化计算消失。数据库在检查点关闭后只读统计当前保留内容，文件大小区分 DB / WAL / SHM。重开只验证正式内容重新载入，不模拟崩溃续接。',
    '',
    '| 检查点 | CP 身份行/保留正文/淘汰正文 | CP 保留原 JSON MiB | CP 保留存储正文 MiB | 最大保留 image KiB | DB 文件 MiB | 空闲页 MiB |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    // Database shape is also preserved verbatim in summary.json for independent inspection.
    ...summary.snapshots.map((item) => {
      const { images, heads } = item.database.checkpoints;
      const original = images.bytes + heads.deliveryBytes;
      const stored = (images.storedBytes ?? images.bytes) + (heads.storedDeliveryBytes ?? heads.deliveryBytes);
      return `| ${item.after} | ${images.count}/${images.retainedBodies ?? '未测量'}/${images.discardedBodies ?? '未测量'} | ${mib(original)} | ${mib(stored)} | ${kib(images.maxBytes)} | ${mib(item.database.files.dbBytes)} | ${mib(item.database.sqlite.freelistCount * item.database.sqlite.pageSize)} |`;
    }),
    '',
    '此表 CP 原 JSON 与存储正文均合计保留的 image 和 head delivery，排除索引及 SQLite 页开销。身份行包含已淘汰正文的旧镜像；旧报告缺少正文数量时显示未测量，不补零。v2 原 JSON 按正文计量；v3 起从已检查编码与大小范围的 jsonBytes 元数据汇总，不解压认证载荷。存储正文包含压缩包的 Base64 和 envelope，既不是压缩二进制净大小，也不是磁盘累计写入量。迁移产生的空闲页可能仍占文件空间。',
    '',
    '| 阶段 | 请求数 | usage 覆盖 | 累计请求 JSON MiB | 已报告 input tokens | 已报告 output tokens |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...Object.entries(summary.phases).map(([phase, stats]) => `| ${phase} | ${stats.requests} | ${stats.usageReportedRequests}/${stats.requests} | ${mib(stats.jsonBytes)} | ${stats.promptTokens ?? '未提供'} | ${stats.completionTokens ?? '未提供'} |`),
    '',
    reported ? `已报告 usage 合计：input ${inputTokens} + output ${outputTokens} = ${totalTokens} tokens；覆盖 ${reported}/${requests} 次请求${reported === requests ? '' : '，未报告部分未知，不按零计费'}。${totalTokens && summary.phases.memory?.usageReportedRequests ? `已报告 token 中记忆维护占 ${((memoryTokens / totalTokens) * 100).toFixed(2)}%。` : ''}` : '模型未提供 usage，不能从请求字节或调用次数推算 token 消耗。',
    '失败、截断和维护被跳过的尝试仍计入消耗；提交完成不等于任务语义成功。本实验没有同模型同任务的基础调用对照，不能将全部 token 称为内核额外开销，也不能据此给出每个正确解决任务的成本。输入/输出 token 单价及缓存计费可能不同，此处不估算金额。',
    '',
    '| 阶段 | 完整缓存计数覆盖 | 已报告命中 tokens | 已报告未命中 tokens | 覆盖部分输入命中率 |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...Object.entries(summary.phases).map(([phase, stats]) => `| ${phase} | ${stats.cacheReportedRequests ?? 0}/${stats.requests} | ${stats.promptCacheHitTokens ?? '未知'} | ${stats.promptCacheMissTokens ?? '未知'} | ${stats.cachePromptTokens > 0 ? `${((stats.promptCacheHitTokens / stats.cachePromptTokens) * 100).toFixed(2)}%` : '未知'} |`),
    '',
    '缓存只汇总同时报告 hit/miss 的请求；命中率以这些请求的 input tokens 为分母。缺失字段、旧实验和无 usage 请求保持未知，单侧计数仍保留在原始事件中，不补零、不外推到全部请求。缓存命中不会抵消原始 token 数。',
    '',
    '| 提交 | 本次调用 ms | CP 持久端口 ms | 首预览 ms | 当前 RecordBook KiB（起始提交） |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...milestones.map((row) => `| ${row.number} | ${row.elapsedMs.toFixed(1)} | ${row.checkpoints.saveMs.toFixed(1)} | ${row.firstDeltaMs?.toFixed(1) ?? '无'} | ${kib(row.records.jsonBytes)}（${row.records.fromSubmission}） |`),
    '',
    `记忆提案接纳 ${summary.maintenance.accepted} 次；处理异常后跳过 ${summary.maintenance.handled} 次；未观察到终态 ${summary.maintenance['not-observed']} 次。提交完成不自动说明提取成功。`,
    `内容重新载入对照：${summary.reloads.length} 次，${summary.reloads.every((item) => item.equal) ? '全部一致' : '存在不一致'}。`,
    `语义评估：${summary.mode === 'offline' ? '不适用（离线占位回答）' : '待人工审查 review.md'}。`,
    `执行状态：${summary.complete ? '完成' : '未完成，见 summary.json 的 failure/providerFailure'}。`,
  ];
  return `${lines.join('\n')}\n`;
}

export function renderReview(turns, rows, mode) {
  const lines = ['# 人工语义核对', '', mode === 'offline' ? '离线模式：下列回答为占位回复，不可评分为模型通过。' : '只评价已提供材料内的事实；此表未交给模型。每题可标记通过 / 部分 / 失败 / 无法判断，并记录依据。', ''];
  for (const row of rows) {
    const turn = turns[row.number - 1];
    lines.push(`## ${row.number}. ${turn.topic}`, '', `用户：${turn.input}`, '', `回答：${row.result ?? '未交付'}`, '', '核对依据：', '', ...turn.expectations.map((item) => `- ${item.claim}（来源提交 ${item.sourceTurns.join('、')}）`), '', `提取接纳状态：${row.memoryReception}。`, '', '评价：待核对。', '');
  }
  return `${lines.join('\n')}\n`;
}
