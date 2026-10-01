/**
 * 发布账纯逻辑测试：node --import tsx --test 不适用当前环境，
 * 直接以断言脚本运行：node scripts/test-ledger.mjs（内联引用 dist 或 ts 编译）。
 * 为零依赖，这里用 ts 源码 + 简单断言，由 npm run test:ledger 经 tsc 后执行。
 */
import assert from 'node:assert/strict';
import type { ReleaseLedger } from '../src/app/ledger/ledger.models';
import { markRolledBack, retargetBatch, submitReceipts, summarizeBatch } from '../src/app/ledger/ledger';

function seedLedger(): ReleaseLedger {
  const now = new Date().toISOString();
  return {
    groups: [
      { id: 'g-a', name: 'A 组', region: '华东', count: 100, compatible: true, offlineGateways: 0 },
      { id: 'g-b', name: 'B 组', region: '华南', count: 50, compatible: true, offlineGateways: 0 },
    ],
    batches: [
      {
        id: 'b1', name: '补丁', firmware: '2.0', rollbackVersion: '1.9', groupIds: ['g-a', 'g-b'],
        rolloutPercent: 10, failureThreshold: 30, status: 'running', revision: 1,
        createdAt: now, updatedAt: now,
      },
    ],
    receipts: [],
    audits: [],
  };
}

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// 1. 每台设备登记安装结果；重复回执只算一次
test('重复回执只落账一次', () => {
  let led = seedLedger();
  const inputs = [
    { receiptId: 'r1', groupId: 'g-a', deviceId: 'd1', firmware: '2.0', result: 'installed' as const },
    { receiptId: 'r1', groupId: 'g-a', deviceId: 'd1', firmware: '2.0', result: 'installed' as const },
    { receiptId: 'r2', groupId: 'g-a', deviceId: 'd2', firmware: '2.0', result: 'failed' as const },
  ];
  const r1 = submitReceipts({ ledger: led, batchId: 'b1', actor: '值班甲', inputs });
  led = r1.ledger;
  assert.equal(led.receipts.length, 2);
  assert.equal(r1.outcome.kind, 'committed');
  if (r1.outcome.kind === 'committed') {
    assert.equal(r1.outcome.applied, 2);
    assert.deepEqual(r1.outcome.duplicates, ['r1']);
  }
  const stats = summarizeBatch(led.batches[0], led.groups, led.receipts);
  assert.equal(stats.installed, 1);
  assert.equal(stats.failed, 1);
  // 再交一次同样的回执号仍然不计数
  const r2 = submitReceipts({ ledger: led, batchId: 'b1', actor: '值班甲', inputs: [inputs[0]] });
  assert.equal(r2.ledger.receipts.length, 2);
  assert.equal(summarizeBatch(r2.ledger.batches[0], led.groups, r2.ledger.receipts).installed, 1);
});

// 2. pending 回执先占位，最终结论回执不重复计数
test('pending 占位后被 installed 回执替代不重复计数', () => {
  let led = seedLedger();
  led = submitReceipts({
    ledger: led, batchId: 'b1', actor: '甲',
    inputs: [{ receiptId: 'p1', groupId: 'g-a', deviceId: 'd1', firmware: '2.0', result: 'pending' }],
  }).ledger;
  let stats = summarizeBatch(led.batches[0], led.groups, led.receipts);
  assert.equal(stats.pending, 1);
  const ga = stats.groupRollouts.find((g) => g.groupId === 'g-a')!;
  assert.equal(ga.occupied, 1);
  assert.equal(ga.free, 9);
  led = submitReceipts({
    ledger: led, batchId: 'b1', actor: '甲',
    inputs: [{ receiptId: 'p2', groupId: 'g-a', deviceId: 'd1', firmware: '2.0', result: 'installed' }],
  }).ledger;
  stats = summarizeBatch(led.batches[0], led.groups, led.receipts);
  assert.equal(stats.installed, 1);
  assert.equal(stats.pending, 0);
  assert.equal(stats.downloaded, 1, '占位顺延，总数不能变 2');
  const ga2 = stats.groupRollouts.find((g) => g.groupId === 'g-a')!;
  assert.equal(ga2.occupied, 1);
  assert.equal(ga2.free, 9);
  assert.equal(led.receipts.length, 2, '流水仍保留两行（追加不删账）');
  assert.ok(led.receipts.find((r) => r.receiptId === 'p1')!.supersededBy === 'p2');
});

// 3. 版本变化后旧版本未执行回执失效并释放占位，已安装设备保留现场
test('版本变化：旧 pending 失效释放占位，旧 installed 保留', () => {
  let led = seedLedger();
  led = submitReceipts({
    ledger: led, batchId: 'b1', actor: '甲',
    inputs: [
      { receiptId: 'r1', groupId: 'g-a', deviceId: 'd1', firmware: '2.0', result: 'pending' },
      { receiptId: 'r2', groupId: 'g-a', deviceId: 'd2', firmware: '2.0', result: 'installed' },
    ],
  }).ledger;
  led = retargetBatch(led, 'b1', '2.1', '发布负责人');
  assert.equal(led.batches[0].firmware, '2.1');
  assert.equal(led.batches[0].status, 'draft');
  const stale = led.receipts.find((r) => r.receiptId === 'r1')!;
  assert.equal(stale.stale, true);
  const kept = led.receipts.find((r) => r.receiptId === 'r2')!;
  assert.equal(kept.stale, undefined);
  assert.equal(kept.result, 'installed');
  let stats = summarizeBatch(led.batches[0], led.groups, led.receipts);
  assert.equal(stats.pending, 0);
  assert.equal(stats.installed, 0, '新版本账期尚无设备');
  assert.equal(stats.retained, 1, '旧版本已安装设备保留现场');
  const ga = stats.groupRollouts.find((g) => g.groupId === 'g-a')!;
  assert.equal(ga.occupied, 0);
  assert.equal(ga.free, 10, '占位全部释放');

  // 新版本审批运行后，迟到的旧版本回执不能推进
  led = { ...led, batches: led.batches.map((b) => (b.id === 'b1' ? { ...b, status: 'running' } : b)) };
  const late = submitReceipts({
    ledger: led, batchId: 'b1', actor: '乙',
    inputs: [
      { receiptId: 'r3', groupId: 'g-a', deviceId: 'd1', firmware: '2.0', result: 'installed' },
      { receiptId: 'r4', groupId: 'g-a', deviceId: 'd3', firmware: '2.1', result: 'installed' },
    ],
  });
  assert.equal(late.outcome.kind, 'committed');
  if (late.outcome.kind === 'committed') assert.deepEqual(late.outcome.staleRejected, ['d1']);
  stats = summarizeBatch(late.ledger.batches[0], led.groups, late.ledger.receipts);
  assert.equal(stats.installed, 1);
  assert.equal(stats.retained, 1);
});

// 4. 两个值班员同时提交：后到者看到冲突设备和最新批次
test('乐观并发冲突返回冲突设备与最新批次，可重试条目再交成功', () => {
  let led = seedLedger();
  const first = submitReceipts({
    ledger: led, batchId: 'b1', actor: '值班甲', expectedRevision: 1,
    inputs: [{ receiptId: 'r1', groupId: 'g-a', deviceId: 'd1', firmware: '2.0', result: 'installed' }],
  });
  assert.equal(first.outcome.kind, 'committed');
  led = first.ledger;
  // 值班乙拿着旧 revision 提交，其中 d1 已被甲登记，另带 d2
  const second = submitReceipts({
    ledger: led, batchId: 'b1', actor: '值班乙', expectedRevision: 1,
    inputs: [
      { receiptId: 'r2', groupId: 'g-a', deviceId: 'd1', firmware: '2.0', result: 'installed' },
      { receiptId: 'r3', groupId: 'g-a', deviceId: 'd2', firmware: '2.0', result: 'installed' },
    ],
  });
  assert.equal(second.outcome.kind, 'conflict');
  if (second.outcome.kind === 'conflict') {
    assert.equal(second.outcome.actualRevision, 2);
    assert.equal(second.outcome.currentFirmware, '2.0');
    assert.deepEqual(second.outcome.conflictDevices, ['d1']);
    assert.equal(second.outcome.retriable.length, 2, '两份回执都未落账，均可重试');
  }
  assert.equal(second.ledger.receipts, led.receipts, '冲突不新增回执');
  assert.equal(second.ledger.batches, led.batches, '冲突不动批次');
  assert.ok(second.ledger.lastOutcome?.kind === 'conflict', '冲突结果返回给值班员');
  // 乙看到最新 revision 后重试（去掉冲突设备 d1）
  const retry = submitReceipts({
    ledger: led, batchId: 'b1', actor: '值班乙', expectedRevision: 2,
    inputs: [{ receiptId: 'r3', groupId: 'g-a', deviceId: 'd2', firmware: '2.0', result: 'installed' }],
  });
  assert.equal(retry.outcome.kind, 'committed');
  const stats = summarizeBatch(retry.ledger.batches[0], led.groups, retry.ledger.receipts);
  assert.equal(stats.installed, 2);
});

// 5. 写入失败后保留已完成分组，只重试未完成部分
test('部分分组写入失败：保留已完成分组，重试不重复计数', () => {
  let led = seedLedger();
  const first = submitReceipts({
    ledger: led, batchId: 'b1', actor: '甲', failGroups: ['g-b'],
    inputs: [
      { receiptId: 'a1', groupId: 'g-a', deviceId: 'da1', firmware: '2.0', result: 'installed' },
      { receiptId: 'b1r', groupId: 'g-b', deviceId: 'db1', firmware: '2.0', result: 'installed' },
    ],
  });
  assert.equal(first.outcome.kind, 'partial');
  if (first.outcome.kind === 'partial') {
    assert.deepEqual(first.outcome.committedGroups, ['g-a']);
    assert.deepEqual(first.outcome.failedGroups, ['g-b']);
    assert.equal(first.outcome.applied, 1);
  }
  led = first.ledger;
  let stats = summarizeBatch(led.batches[0], led.groups, led.receipts);
  assert.equal(stats.installed, 1, 'A 组已落账保留');
  assert.equal(led.receipts.length, 1);

  // 重试：把成功组的回执也带回来（同号）+ 失败组的回执。同号幂等，不重复计数
  const retry = submitReceipts({
    ledger: led, batchId: 'b1', actor: '甲',
    inputs: [
      { receiptId: 'a1', groupId: 'g-a', deviceId: 'da1', firmware: '2.0', result: 'installed' },
      { receiptId: 'b1r', groupId: 'g-b', deviceId: 'db1', firmware: '2.0', result: 'installed' },
    ],
  });
  assert.equal(retry.outcome.kind, 'committed');
  if (retry.outcome.kind === 'committed') {
    assert.equal(retry.outcome.applied, 1, '只有 B 组一台是新落账');
    assert.deepEqual(retry.outcome.duplicates, ['a1']);
  }
  stats = summarizeBatch(retry.ledger.batches[0], led.groups, retry.ledger.receipts);
  assert.equal(stats.installed, 2);
  assert.equal(retry.ledger.receipts.length, 2);
});

// 6. 重试不能覆盖回滚
test('回滚后回执一律拒收，重试也不能覆盖', () => {
  let led = seedLedger();
  led = submitReceipts({
    ledger: led, batchId: 'b1', actor: '甲',
    inputs: [{ receiptId: 'r1', groupId: 'g-a', deviceId: 'd1', firmware: '2.0', result: 'installed' }],
  }).ledger;
  led = markRolledBack(led, 'b1', '发布负责人');
  assert.equal(led.batches[0].status, 'rolled_back');
  const installedKept = summarizeBatch(led.batches[0], led.groups, led.receipts);
  assert.equal(installedKept.installed, 1, '已安装现场保留');
  const rejected = submitReceipts({
    ledger: led, batchId: 'b1', actor: '乙',
    inputs: [{ receiptId: 'r9', groupId: 'g-a', deviceId: 'd9', firmware: '2.0', result: 'installed' }],
  });
  assert.equal(rejected.outcome.kind, 'rejected');
  if (rejected.outcome.kind === 'rejected') assert.equal(rejected.outcome.reason, 'rolled_back');
  assert.equal(rejected.ledger.receipts, led.receipts, '回滚后不新增回执');
  assert.deepEqual(rejected.ledger.batches, led.batches, '回滚后账目不被任何回执改动');
  assert.ok(rejected.ledger.lastOutcome?.kind === 'rejected');
});

// 7. 暂停/回滚后迟到的回执不能继续推进
test('暂停批次的回执不产生完成推进', () => {
  let led = seedLedger();
  led = { ...led, batches: led.batches.map((b) => (b.id === 'b1' ? { ...b, status: 'paused' } : b)) };
  const res = submitReceipts({
    ledger: led, batchId: 'b1', actor: '甲',
    inputs: [{ receiptId: 'r1', groupId: 'g-a', deviceId: 'd1', firmware: '2.0', result: 'installed' }],
  });
  // 登记仍然有效（设备现场），但状态不会被推到 completed/running
  assert.equal(res.ledger.batches[0].status, 'paused');
  assert.equal(summarizeBatch(res.ledger.batches[0], led.groups, res.ledger.receipts).installed, 1);
});

// 8. 超出分组容量的回执不占位
test('超出灰度容量的回执被拒', () => {
  let led = seedLedger();
  const inputs = Array.from({ length: 12 }, (_, i) => ({
    receiptId: `r${i}`, groupId: 'g-a' as const, deviceId: `d${i}`, firmware: '2.0', result: 'installed' as const,
  }));
  const res = submitReceipts({ ledger: led, batchId: 'b1', actor: '甲', inputs });
  led = res.ledger;
  if (res.outcome.kind === 'committed') {
    assert.equal(res.outcome.applied, 10, 'A 组容量 100*10%=10');
    assert.equal(res.outcome.overflow.length, 2);
  }
  const ga = summarizeBatch(led.batches[0], led.groups, led.receipts).groupRollouts.find((g) => g.groupId === 'g-a')!;
  assert.equal(ga.occupied, 10);
  assert.equal(ga.free, 0);
});

console.log(`\n全部 ${passed} 项发布账测试通过`);
