const number = (value, digits = 1) => (Number.isFinite(value) ? value.toFixed(digits) : '—');
const mib = (value) => number(value / 1024 / 1024);

export function renderReport(environment, cases) {
  const lines = ['# CAPiX 多会话容量实验', '', `运行日期：${environment.startedAt}。${environment.platform} / ${environment.arch}，${environment.cpu}，${environment.cpus} 个逻辑核，内存 ${mib(environment.memoryBytes)} MiB，Node ${environment.node}。`, '', '范围：单运行进程中的独立会话，共享真实 ChatCompletionsProvider；模拟模型在另一进程，通过 loopback HTTP/SSE 返回。不是多用户 HTTP 应用、认证、供应商容量或浏览器慢读者测试。', '', '每个成功提交执行完整默认服务链：一个流式回答交互、一个非流式记忆提案交互，返回合法空 changes；不评价记忆质量。各会话独立内容、View 和结构。', '', `已执行 ${cases.length}/${environment.cases.length} 个计划场景。`, '', '## 完成与时延', '', '| 场景 | 有效 | 提交/接纳/成功 | 拒绝/取消/失败 | 模型失败 | 峰值待返回/占用/模型客户端/上游 | 完成/s | 首增量 p95 ms | 成功完成 p95/p99 ms | 调度延迟 p95 ms |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const result of cases) {
    const w = result.workload ?? {};
    const l = result.latencyMs ?? {};
    lines.push(`| ${result.config.name} | ${result.valid ? '通过' : '失败'} | ${w.offered ?? 0}/${w.acquired ?? 0}/${w.succeeded ?? 0} | ${w.rejected ?? 0}/${w.cancelled ?? 0}/${w.failed ?? 0} | ${result.models?.failed ?? 0} | ${w.peakLocalCalls ?? 0}/${w.peakAcquiredCalls ?? 0}/${w.peakModelCalls ?? 0}/${result.upstream?.peakActive ?? 0} | ${number(w.completedPerSecond)} | ${number(l.firstDelta?.p95)} | ${number(l.successfulCompletion?.p95)}/${number(l.successfulCompletion?.p99)} | ${number(l.schedulerDelay?.p95)} |`);
  }
  lines.push('', '## 进程与存储', '', '| 场景 | 冷装配 ms | CPU（单核=100%） | 事件循环 p99 ms | RSS 峰值采样 MiB | heap 峰值采样 MiB | 关闭后 heap MiB | 外部收尾 ms |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const result of cases) {
    const work = result.work ?? {};
    lines.push(`| ${result.config.name} | ${number(result.build?.elapsedMs)} | ${number(work.cpuPercentOfOneCore)}% | ${number(work.eventLoopDelayMs?.p99)} | ${mib(work.memory?.peakSampled?.rss)} | ${mib(work.memory?.peakSampled?.heapUsed)} | ${mib(result.afterCloseMemory?.heapUsed)} | ${number(result.workload?.externalDrainMs)} |`);
  }
  lines.push('', '| 场景 | 数据库数 | 关闭后文件 MiB | CP 身份行/保留正文/淘汰正文 | CP 保留存储/原始 JSON MiB | 反馈条目 | 重载核对 |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const result of cases) {
    const storage = result.storage ?? {};
    lines.push(`| ${result.config.name} | ${storage.databases ?? 0} | ${mib(storage.totalBytes)} | ${storage.tables?.checkpoint_images ?? 0}/${storage.checkpointRetainedBodies ?? '未测量'}/${storage.checkpointDiscardedBodies ?? '未测量'} | ${mib(storage.checkpointStoredBytes)}/${mib(storage.checkpointJsonBytes)} | ${storage.tables?.completion_interactions ?? 0} | ${result.persistenceReloads?.verified ?? 0}/${result.persistenceReloads?.expected ?? 0} |`);
  }
  lines.push(
    '',
    '各场景完整的模型耗时/流量、上游实际 CPU/时序、关闭后的数据库统计、残留活动和逐提交时延见对应 `result.json`。CP 身份行包括已淘汰正文的旧镜像；正文数量缺失的旧报告保持未测量。文件尺寸与保留 JSON 存量都不是累计写入字节。',
    '',
    '## 解读约束',
    '',
    '- 每个场景在新进程运行，组内包含冷请求，不把单次采样称为稳定容量上限。',
    '- 首增量和完成从实际 runner.run 开始计时；同时保存计划到达时间、调度延迟及计划到完成时延，未隐藏阻塞。固定到达率遇到 busy 原样统计拒绝，不排队重试。',
    '- 吞吐以成功完成数除以包含收尾的调用窗口；不是仅统计发起次数或 HTTP 200。独立发送另等待 settled 并核对残留为零。',
    '- SQLite 采用现有每会话单库布局。CP 开关差额包含 applyFixed 凭据、实体提交和镜像保存，不只是序列化成本。记录组保留真实采集，其他组为 idle。',
    '- 固定模型延时是目标；上游与客户端实际耗时均保留。不能把客户端耗时减去预设延时后的差额全部认定为框架开销。',
    '- 内存按 50ms 采样，峰值可能漏过瞬时尖峰；另存进程 maxRSS。关闭后显式 GC（若可用），但正文、交互反馈、CP、记录和测试结果有合法留存，短时数据不能证明无泄漏。',
    '- 持续负载为本配置的短样本，不是长期稳定性认证。调用取消/输出解除订阅不代表撤销外部模型执行。',
    '',
  );
  for (const result of cases.filter((item) => !item.valid)) lines.push(`失败 ${result.config.name}：${result.failure?.message ?? 'worker未交付完整报告'}`, '');
  return lines.join('\n');
}
