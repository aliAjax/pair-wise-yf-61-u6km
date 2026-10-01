import '@angular/compiler';
import { releaseReducer } from './release.reducer';
import {
  submitReceipts,
  retryOutbox,
  changeBatchVersion,
  rollbackBatch,
  pauseBatch,
  telemetryTick,
} from './release.actions';
import type { ReleaseState } from './release.models';

let state: ReleaseState = releaseReducer(undefined, { type: '@init' });
let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures += 1;
}

const batchId = 'batch-demo';
const v = () => state.batches.find((b) => b.id === batchId)!.version;
const receipts = () => state.receipts.filter((r) => r.batchId === batchId);
const installed = () => receipts().filter((r) => r.status === 'installed').length;
const queued = () => receipts().filter((r) => r.status === 'queued').length;
const invalidated = () => receipts().filter((r) => r.status === 'invalidated').length;

// 1. 幂等：同设备重复回执只算一次
state = releaseReducer(state, submitReceipts({
  batchId, actor: '甲', expectedVersion: v(),
  items: [
    { deviceId: 'g-edge#1', groupId: 'g-edge', result: 'installed' },
    { deviceId: 'g-edge#2', groupId: 'g-edge', result: 'installed' },
  ],
}));
state = releaseReducer(state, telemetryTick());
state = releaseReducer(state, telemetryTick());
check('两台设备回执入账', receipts().length === 2);
check('执行后 installed=2', installed() === 2);
state = releaseReducer(state, submitReceipts({
  batchId, actor: '乙', expectedVersion: v(),
  items: [{ deviceId: 'g-edge#1', groupId: 'g-edge', result: 'installed' }],
}));
check('重复回执不重复计数（仍为2）', receipts().length === 2 && installed() === 2);

// 2. 乐观并发：后到者看到冲突设备与最新批次
const before = state;
state = releaseReducer(state, submitReceipts({
  batchId, actor: '丙', expectedVersion: v(), simulateConcurrent: true,
  items: [
    { deviceId: 'g-edge#1', groupId: 'g-edge', result: 'installed' },
    { deviceId: 'g-edge#3', groupId: 'g-edge', result: 'installed' },
  ],
}));
check('并发冲突被拒绝（未入账新设备）', receipts().length === 2);
check('冲突报告含冲突设备#1', state.conflict?.conflictingDevices.includes('g-edge#1') === true);
check('冲突报告不含未登记的#3', state.conflict?.conflictingDevices.includes('g-edge#3') === false);
check('冲突报告含最新批次版本', state.conflict?.currentVersion === v());
check('冲突报告含最新批次状态', state.conflict?.latestStatus === state.batches.find((b) => b.id === batchId)!.status);

// 3. 版本变更：未执行回执失效并释放占位，已安装保留现场
state = releaseReducer(before, changeBatchVersion({ id: batchId, firmware: '3.0.0', actor: '发布负责人' }));
check('版本号升级为2', v() === 2);
check('已安装设备保留现场（installed 仍为2）', installed() === 2);
check('无排队回执（全部已执行）', queued() === 0);
// 制造排队回执后再变更版本
state = releaseReducer(state, submitReceipts({
  batchId, actor: '甲', expectedVersion: v(),
  items: [{ deviceId: 'g-edge#9', groupId: 'g-edge', result: 'installed' }],
}));
check('新回执排队中', queued() === 1);
state = releaseReducer(state, changeBatchVersion({ id: batchId, firmware: '3.1.0', actor: '发布负责人' }));
check('升级后排队回执失效', invalidated() === 1);
check('已安装仍保留现场（installed=2）', installed() === 2);
check('批次固件已更新', state.batches.find((b) => b.id === batchId)!.firmware === '3.1.0');

// 4. 部分写入失败：保留已完成分组，只重试未完成部分
state = releaseReducer(state, submitReceipts({
  batchId, actor: '甲', expectedVersion: v(), forceFailure: true,
  items: [
    { deviceId: 'g-edge#10', groupId: 'g-edge', result: 'installed' },
    { deviceId: 'g-clinic#20', groupId: 'g-clinic', result: 'installed' },
  ],
}));
check('首个分组失败进入发件箱', state.outbox.length === 1 && state.outbox[0].status === 'pending');
check('已完成分组（g-clinic）保留', receipts().some((r) => r.deviceId === 'g-clinic#20'));
check('失败分组（g-edge#10）未入账', !receipts().some((r) => r.deviceId === 'g-edge#10'));
state = releaseReducer(state, retryOutbox({ actor: '甲' }));
check('重试后发件箱清空', state.outbox.length === 0);
check('重试补写 g-edge#10', receipts().some((r) => r.deviceId === 'g-edge#10'));
check('重试未重复计数（g-clinic#20 仍只一条）', receipts().filter((r) => r.deviceId === 'g-clinic#20').length === 1);

// 5. 重试不覆盖回滚
state = releaseReducer(state, submitReceipts({
  batchId, actor: '甲', expectedVersion: v(), forceFailure: true,
  items: [{ deviceId: 'g-edge#30', groupId: 'g-edge', result: 'installed' }],
}));
check('回滚前有一条待重试', state.outbox.length === 1);
state = releaseReducer(state, rollbackBatch({ id: batchId, actor: '发布负责人' }));
state = releaseReducer(state, retryOutbox({ actor: '甲' }));
check('回滚后重试被拒绝（不覆盖回滚）', state.outbox[0]?.status === 'rejected');
check('回滚状态保持', state.batches.find((b) => b.id === batchId)!.status === 'rolled_back');
check('回滚后重试未写入新设备', !receipts().some((r) => r.deviceId === 'g-edge#30'));

// 6. 晚到回执不得推进已暂停批次
const pausedBatch = 'batch-paused';
state = releaseReducer(undefined, { type: '@init' });
state = releaseReducer(state, { type: '[Release] Create batch', batch: { id: pausedBatch, name: '暂停批', firmware: '1.0.0', rollbackVersion: '0.9', groupId: 'g-edge', rolloutPercent: 10, failureThreshold: 5, status: 'paused', progress: 0, downloaded: 0, failed: 0, version: 1, updatedAt: '' } });
state = releaseReducer(state, pauseBatch({ id: pausedBatch, actor: '值班' }));
state = releaseReducer(state, submitReceipts({
  batchId: pausedBatch, actor: '乙', expectedVersion: 1,
  items: [{ deviceId: 'g-edge#1', groupId: 'g-edge', result: 'installed' }],
}));
check('暂停批次晚到回执被拒绝', state.receipts.filter((r) => r.batchId === pausedBatch).length === 0);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
