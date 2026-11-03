import assert from 'node:assert/strict';
import { PersistenceError } from '@capix/diagnostics';
import { ArchiveStore, PublicationArchive } from './business-progress/archive.mjs';
import { InteractionJournal, createGateway } from './business-progress/interaction.mjs';
import { ProgressStore, PublicationProgress } from './business-progress/progress.mjs';
import { createPublicationRunner } from './business-progress/workflow.mjs';

// 离线实验：只使用本例的内存权威存储和可序列化快照，不访问模型、文件或数据库。
// 三个存储分别提交；所有推进都由普通 Node/Group/资源操作完成，没有 CP 或旧调用恢复。
const journal = new InteractionJournal();
const archiveStore = new ArchiveStore();
const progressStore = new ProgressStore(['整理发布安排'], archiveStore.id);
const response = Promise.withResolvers();
let sends = 0;
const host = createGateway(journal, () => {
  sends++;
  return response.promise;
});
const archive = new PublicationArchive(archiveStore);
const progress = new PublicationProgress(progressStore, host.gateway, archive);
const runner = createPublicationRunner({ progress, archive, gateway: host.gateway });

try {
  const pending = await runner.run();
  assert.equal(pending.status, 'pending');
  assert.equal(runner.isRunning, false);
  assert.equal(host.interactions.active, true);
  console.log('1. 调用已退出，业务资源保存了交接引用，外部交互仍在进行。');

  response.resolve('周四复核，周五发布。');
  await host.interactions.settled();
  progressStore.failNext('accept', 'before');
  await assert.rejects(runner.run(), (error) => error instanceof PersistenceError);
  assert.equal(archiveStore.dump().entries.length, 1);
  assert.equal(progress.read().items[0].acceptance, undefined);
  console.log('2. 目标已发布，业务接纳保存失败；两份事实没有混成一个完成标志。');

  // 只取 JSON 值重建全部装配，后续不复用旧对象。新调用不需要上次的局部 ref。
  const saved = JSON.parse(JSON.stringify({ interactions: journal.dump(), progress: progressStore.dump(), archive: archiveStore.dump() }));
  host.interactions.close();
  const reopened = createGateway(InteractionJournal.restore(saved.interactions), () => {
    sends++;
    throw new Error('A stored interaction must not be sent again');
  });
  try {
    const restoredArchive = new PublicationArchive(ArchiveStore.restore(saved.archive));
    const restoredProgress = new PublicationProgress(ProgressStore.restore(saved.progress), reopened.gateway, restoredArchive);
    const next = createPublicationRunner({ progress: restoredProgress, archive: restoredArchive, gateway: reopened.gateway });
    const accepted = await next.run();
    assert.equal(accepted.status, 'accepted');
    assert.deepEqual(accepted.receipt, saved.archive.entries[0].receipt);
    assert.equal(sends, 1);
    assert.equal((await next.run()).status, 'complete');
    console.log('3. 全新装配确认原目标凭据，补交业务接纳；发送 1 次，发布 1 次。');
    console.log('4. 再次调用读取已接纳事实，不重复发送、发布或推进。');
  } finally {
    await reopened.interactions.settled();
    reopened.interactions.close();
  }
} finally {
  response.resolve('周四复核，周五发布。');
  await host.interactions.settled();
  host.interactions.close();
}

// 再用相同结构处理两个业务事项：仅业务资源中的固定操作与顺序发生变化。
const orderedJournal = new InteractionJournal();
const orderedArchiveStore = new ArchiveStore();
const orderedStore = new ProgressStore(['拟定发布说明', '拟定验收说明'], orderedArchiveStore.id);
let orderedSends = 0;
const orderedHost = createGateway(orderedJournal, (input) => {
  orderedSends++;
  return `已完成：${input}`;
});
const orderedArchive = new PublicationArchive(orderedArchiveStore);
const orderedProgress = new PublicationProgress(orderedStore, orderedHost.gateway, orderedArchive);
try {
  for (const item of orderedProgress.read().items) {
    const entry = createPublicationRunner({ progress: orderedProgress, archive: orderedArchive, gateway: orderedHost.gateway });
    let result = await entry.run();
    await orderedHost.interactions.settled();
    if (result.status === 'pending') result = await entry.run();
    assert.equal(result.status, 'accepted');
    assert.equal(result.itemId, item.id);
  }
  assert.equal(orderedSends, 2);
  assert.equal(orderedArchiveStore.dump().entries.length, 2);
  console.log('5. 两个事项按业务顺序接纳，使用同一套结构；每个事项各发送、发布一次。');
} finally {
  await orderedHost.interactions.settled();
  orderedHost.interactions.close();
}
