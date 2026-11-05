const number = (value, digits = 1) => (Number.isFinite(value) ? value.toFixed(digits) : '—');

export function renderServerReport(environment, results) {
  const lines = ['# HTTP 多进程容量实验', '', `${environment.cpu} · ${environment.cpus} logical CPUs · ${number(environment.memoryBytes / 2 ** 30, 0)} GiB · ${environment.platform}/${environment.arch} · ${environment.node}`, '', '独立负载进程 → 每会话固定端口的真实 Conversation Web host → 共享独立 HTTP/SSE 模型模拟器。全部进程在同一机器；固定会话归属，没有生产负载均衡器。每会话独立 SQLite、开启 CP、记录 idle。', '', '“完整负载通过”要求全部计划提交成功、预览及正式持久回答准确、模型调用无失败、消息/View 数量正确、全部数据库重载一致、上游无残留。“体验线”只是本次筛选条件：完成 p95 ≤ 2 s、首增量 p95 ≤ 0.5 s、发生器调度 p99 ≤ 50 ms；不是产品 SLA。', '', '| 场景 | worker | 提交/s | 时长 s | 成功/计划 | 模型失败 | 完成 p95 ms | 首增量 p95 ms | CPU 核合计 | 最慢 loop p99 ms | 完整负载 | 体验线 |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |'];
  for (const result of results) {
    const load = result.load;
    lines.push(`| ${result.config.name} | ${result.config.workers} | ${result.config.rate} | ${result.config.durationSeconds} | ${load?.workload?.succeeded ?? 0}/${load?.workload?.offered ?? '—'} | ${result.modelFailures ?? '—'} | ${number(load?.latencyMs?.completion?.p95)} | ${number(load?.latencyMs?.firstDelta?.p95)} | ${number(result.workerCpuCores, 2)} | ${number(result.maxWorkerEventLoopP99Ms)} | ${result.valid ? '通过' : '失败'} | ${result.withinExploratoryLatency ? '通过' : '未通过'} |`);
  }
  lines.push('', '## 每档详情', '');
  for (const result of results) {
    const load = result.load;
    lines.push(
      `### ${result.config.name}`,
      '',
      `完成吞吐（含排空）${number(load?.workload?.successPerSecondIncludingDrain, 2)}/s；峰值 HTTP 在途 ${load?.workload?.peakActive ?? '—'}；排空 ${number(load?.workload?.drainMs)} ms；调度延迟 p99 ${number(load?.latencyMs?.schedulerDelay?.p99)} ms。`,
      '',
      `worker RSS 峰值之和（非同一时刻整机实测）${number(result.workerPeakRssSum / 2 ** 20)} MiB；独立负载进程 CPU ${number(result.generator?.cpuPercentOfOneCore)}%；上游峰值在途 ${result.upstream?.peakActive ?? '—'}。`,
      '',
      `失败或不满足项：${
        result.checks
          ?.filter((check) => !check.pass)
          .map((check) => check.name)
          .join('；') ||
        result.failure?.message ||
        '无'
      }。`,
      '',
    );
  }
  lines.push('## 解释范围', '', '- 默认每会话 2 KiB 初始历史、一条记忆；回答约 2 KiB、20 片、目标 1 s，记忆提案目标 100 ms、空变更。历史随提交累积，长时吞吐不能从短时样本线性外推。', '- 每档全新进程与数据库；固定到达率，不等待前一提交完成、不重试、不隐藏 busy。多个速率点只形成已测区间，不证明单机绝对上限。', '- 记录每 5 s 的实际开始/完成/在途；区别积压与一次慢请求。未通过完整负载验收的吞吐不计作完整链路的正常容量。', '- 没有共享数据库写者、TLS、认证、生产代理或真实模型配额；也没有验证 worker 崩溃后的会话迁移。', '- 全部原始请求指标、模型指标、worker 日志及实验数据库保留于本目录。', '');
  return lines.join('\n');
}
