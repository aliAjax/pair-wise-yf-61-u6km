import { createReducer, on } from '@ngrx/store';
import type {
  AuditEntry,
  ConflictReport,
  DeviceGroup,
  DeviceReceipt,
  Notice,
  PendingWrite,
  ReleaseBatch,
  ReleaseState,
} from './release.models';
import {
  approveBatch,
  changeBatchVersion,
  clearConflict,
  clearNotice,
  clearRejectedOutbox,
  createBatch,
  pauseBatch,
  resumeBatch,
  rollbackBatch,
  submitReceipts,
  retryOutbox,
  telemetryTick,
} from './release.actions';

const initialGroups: DeviceGroup[] = [
  { id: 'g-edge', name: '华东边缘网关', region: '华东', count: 680, compatible: true, offlineGateways: 4 },
  { id: 'g-plant', name: '工业采集终端', region: '华南', count: 1240, compatible: false, offlineGateways: 12 },
  { id: 'g-clinic', name: '远程诊疗终端', region: '新加坡', count: 310, compatible: true, offlineGateways: 2 }
];
const now = new Date().toISOString();
const initialBatches: ReleaseBatch[] = [
  { id: 'batch-demo', name: '边缘网关安全补丁 2.8.1', firmware: '2.8.1', rollbackVersion: '2.7.9', groupId: 'g-edge', rolloutPercent: 20, failureThreshold: 5, status: 'approved', progress: 0, downloaded: 0, failed: 0, version: 1, updatedAt: now }
];
const initialAudits: AuditEntry[] = [{ id: 'audit-1', at: now, actor: '运维值班', message: '批次 batch-demo 完成兼容性检查并进入已审批' }];

const STORAGE_KEY = 'firmware-release-v2';

function buildFallback(): ReleaseState {
  return { groups: initialGroups, batches: initialBatches, receipts: [], outbox: [], conflict: null, notice: null, audits: initialAudits };
}

function loadState(): ReleaseState {
  const fallback = buildFallback();
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<ReleaseState>;
    return {
      ...fallback,
      ...parsed,
      conflict: null,
      notice: null,
      receipts: parsed.receipts ?? [],
      outbox: parsed.outbox ?? [],
      batches: (parsed.batches ?? fallback.batches).map((batch) => ({ ...batch, version: batch.version ?? 1 })),
    };
  } catch {
    return fallback;
  }
}

function audit(state: ReleaseState, actor: string, message: string): AuditEntry[] {
  return [{ id: crypto.randomUUID(), at: new Date().toISOString(), actor, message }, ...state.audits];
}

function noticeOf(type: Notice['type'], message: string): Notice {
  return { type, message, at: new Date().toISOString() };
}

/** 幂等键：同批次同设备的重复回执只算一次 */
function receiptId(batchId: string, deviceId: string): string {
  return `${batchId}:${deviceId}`;
}

/** 按批次统计已安装/失败/排队数量（失效回执不计） */
function batchReceiptCounts(receipts: DeviceReceipt[], batchId: string) {
  let installed = 0;
  let failed = 0;
  let queued = 0;
  for (const receipt of receipts) {
    if (receipt.batchId !== batchId || receipt.status === 'invalidated') continue;
    if (receipt.status === 'installed') installed += 1;
    else if (receipt.status === 'failed') failed += 1;
    else if (receipt.status === 'queued') queued += 1;
  }
  return { installed, failed, queued };
}

export const releaseReducer = createReducer(
  loadState(),

  on(createBatch, (state, { batch }) => ({
    ...state,
    batches: [{ ...batch, version: 1 }, ...state.batches],
    audits: audit(state, '发布负责人', `创建批次 ${batch.name}`)
  })),

  on(approveBatch, (state, { id, actor }) => ({
    ...state,
    batches: state.batches.map((batch) => batch.id === id ? { ...batch, status: 'approved', updatedAt: new Date().toISOString() } : batch),
    audits: audit(state, actor, `批次 ${id} 审批通过`)
  })),

  on(pauseBatch, (state, { id, actor }) => ({
    ...state,
    batches: state.batches.map((batch) => batch.id === id ? { ...batch, status: 'paused', updatedAt: new Date().toISOString() } : batch),
    audits: audit(state, actor, `批次 ${id} 已暂停`)
  })),

  on(resumeBatch, (state, { id, actor }) => ({
    ...state,
    batches: state.batches.map((batch) => batch.id === id ? { ...batch, status: 'running', updatedAt: new Date().toISOString() } : batch),
    audits: audit(state, actor, `批次 ${id} 恢复发布`)
  })),

  on(rollbackBatch, (state, { id, actor }) => ({
    ...state,
    batches: state.batches.map((batch) => batch.id === id ? { ...batch, status: 'rolled_back', updatedAt: new Date().toISOString() } : batch),
    audits: audit(state, actor, `批次 ${id} 已紧急回滚`)
  })),

  // 发布账：登记安装回执
  on(submitReceipts, (state, { batchId, items, actor, expectedVersion, simulateConcurrent, forceFailure }) => {
    const batch = state.batches.find((item) => item.id === batchId);
    if (!batch) return state;
    const at = new Date().toISOString();

    // 规则：批次已暂停或回滚时，晚到回执不得继续推进
    if (batch.status === 'rolled_back' || batch.status === 'paused') {
      const reason = batch.status === 'rolled_back' ? '已回滚' : '已暂停';
      return {
        ...state,
        notice: noticeOf('error', `批次 ${batch.name} ${reason}，晚到回执不予写入，不得继续推进`),
        audits: audit(state, actor, `拒绝晚到回执：批次 ${batchId} ${reason}，${items.length} 台设备回执未入账`)
      };
    }

    // 规则：乐观并发——后到提交看到冲突设备与最新批次
    const effectiveExpected = simulateConcurrent ? batch.version - 1 : expectedVersion;
    if (effectiveExpected !== batch.version) {
      const activeIds = new Set(
        state.receipts
          .filter((receipt) => receipt.batchId === batchId && receipt.status !== 'invalidated')
          .map((receipt) => receipt.id)
      );
      const conflictingDevices = [...new Set(
        items.map((item) => item.deviceId).filter((deviceId) => activeIds.has(receiptId(batchId, deviceId)))
      )];
      const conflict: ConflictReport = {
        batchId,
        batchName: batch.name,
        expectedVersion: effectiveExpected,
        currentVersion: batch.version,
        conflictingDevices,
        latestFirmware: batch.firmware,
        latestStatus: batch.status,
        message: `回执携带的批次版本 v${effectiveExpected} 已过期，最新为 v${batch.version}（固件 ${batch.firmware}，状态 ${batch.status}）`,
        at
      };
      return {
        ...state,
        conflict,
        notice: noticeOf('warn', `并发冲突：${conflictingDevices.length} 台设备已被先到回执登记，最新批次 v${batch.version}`),
        audits: audit(state, actor, `并发冲突：后到回执版本 v${effectiveExpected} 过期，冲突设备 ${conflictingDevices.length} 台，最新批次 v${batch.version}`)
      };
    }

    // 规则：分组写入——按组提交，失败分组保留到发件箱，已完成分组保留现场
    const groupIds = [...new Set(items.map((item) => item.groupId))];
    const applied: DeviceReceipt[] = [];
    const outboxEntries: PendingWrite[] = [];
    const failedGroups: string[] = [];
    let duplicated = 0;

    groupIds.forEach((groupId, index) => {
      const groupItems = items.filter((item) => item.groupId === groupId);
      if (forceFailure && index === 0) {
        failedGroups.push(groupId);
        outboxEntries.push({
          id: crypto.randomUUID(),
          batchId,
          items: groupItems,
          actor,
          expectedVersion: batch.version,
          attempts: 1,
          status: 'pending',
          reason: 'network',
          createdAt: at
        });
        return;
      }
      for (const item of groupItems) {
        const id = receiptId(batchId, item.deviceId);
        // 幂等：同设备重复回执只算一次
        if (state.receipts.some((receipt) => receipt.id === id) || applied.some((receipt) => receipt.id === id)) {
          duplicated += 1;
          continue;
        }
        applied.push({
          id,
          batchId,
          groupId: item.groupId,
          deviceId: item.deviceId,
          firmware: batch.firmware,
          result: item.result,
          status: 'queued',
          batchVersion: batch.version,
          submittedBy: actor,
          submittedAt: at
        });
      }
    });

    const receipts = [...applied, ...state.receipts];
    const outbox = [...outboxEntries, ...state.outbox];
    const doneCount = applied.length;
    const groupText = failedGroups.length ? `；分组 ${failedGroups.join('、')} 写入失败，已保留到发件箱待重试` : '';
    return {
      ...state,
      receipts,
      outbox,
      notice: failedGroups.length
        ? noticeOf('warn', `已写入 ${doneCount} 台回执${duplicated ? `，去重 ${duplicated} 台` : ''}${groupText}`)
        : noticeOf('success', `已登记 ${doneCount} 台设备安装结果${duplicated ? `，重复回执去重 ${duplicated} 台，只算一次` : ''}`),
      audits: audit(state, actor, `登记回执：${doneCount} 台写入成功，去重 ${duplicated} 台${failedGroups.length ? `，分组 ${failedGroups.join('、')} 失败待重试` : ''}`)
    };
  }),

  // 发布账：重试发件箱——只补写未完成部分，不重复计数，不覆盖回滚
  on(retryOutbox, (state, { actor }) => {
    if (!state.outbox.length) return state;
    const at = new Date().toISOString();
    const applied: DeviceReceipt[] = [];
    const kept: PendingWrite[] = [];
    let retried = 0;
    let refused = 0;
    let invalidated = 0;
    let deferred = 0;

    for (const entry of state.outbox) {
      const batch = state.batches.find((item) => item.id === entry.batchId);

      // 规则：重试不能覆盖回滚——回滚是终态，永久拒绝
      if (!batch || batch.status === 'rolled_back') {
        refused += 1;
        kept.push({
          ...entry,
          status: 'rejected',
          reason: '批次已回滚，重试被拒绝（不得覆盖回滚）',
          attempts: entry.attempts + 1
        });
        continue;
      }

      // 暂停中：保留待重试，不消耗次数，恢复后可继续
      if (batch.status === 'paused') {
        deferred += 1;
        kept.push({ ...entry, attempts: entry.attempts + 1, reason: '批次已暂停，恢复后可重试' });
        continue;
      }

      // 规则：版本已变更——未执行的过期回执失效，占位已随版本变更释放
      if (batch.version !== entry.expectedVersion) {
        invalidated += 1;
        continue;
      }

      // 补写（幂等）：只写入尚不存在的回执
      for (const item of entry.items) {
        const id = receiptId(entry.batchId, item.deviceId);
        if (state.receipts.some((receipt) => receipt.id === id) || applied.some((receipt) => receipt.id === id)) continue;
        applied.push({
          id,
          batchId: entry.batchId,
          groupId: item.groupId,
          deviceId: item.deviceId,
          firmware: batch.firmware,
          result: item.result,
          status: 'queued',
          batchVersion: batch.version,
          submittedBy: entry.actor,
          submittedAt: at
        });
      }
      retried += 1;
    }

    const receipts = [...applied, ...state.receipts];
    const outbox = kept;
    const parts: string[] = [];
    if (retried) parts.push(`${retried} 条补写成功（${applied.length} 台）`);
    if (refused) parts.push(`${refused} 条因回滚被拒绝（不覆盖回滚）`);
    if (invalidated) parts.push(`${invalidated} 条过期重试已失效并释放占位`);
    if (deferred) parts.push(`${deferred} 条暂停中待恢复后重试`);
    const notice = refused
      ? noticeOf('error', `重试完成：${parts.join('，')}`)
      : invalidated || deferred
        ? noticeOf('warn', `重试完成：${parts.join('，')}`)
        : noticeOf('success', `重试完成：${parts.join('，')}，补写均幂等入账，未重复计数`);
    return {
      ...state,
      receipts,
      outbox,
      notice,
      audits: audit(state, actor, `发件箱重试：${retried} 条补写成功，${refused} 条拒绝覆盖回滚，${invalidated} 条过期失效，${deferred} 条暂停延后`)
    };
  }),

  // 发布账：批次版本变更——未执行回执失效并释放占位，已安装设备保留现场
  on(changeBatchVersion, (state, { id, firmware, actor }) => {
    const batch = state.batches.find((item) => item.id === id);
    if (!batch) return state;
    if (batch.status === 'rolled_back') {
      return {
        ...state,
        notice: noticeOf('error', `批次 ${batch.name} 已回滚，不能再变更版本`),
        audits: audit(state, actor, `拒绝版本变更：批次 ${id} 已回滚`)
      };
    }
    const at = new Date().toISOString();
    const newVersion = batch.version + 1;

    // 已安装/已失败（已执行）回执保留现场；排队中（未执行）回执失效，释放分组占位
    const receipts = state.receipts.map((receipt) => {
      if (receipt.batchId !== id || receipt.status === 'invalidated') return receipt;
      if (receipt.status === 'queued') return { ...receipt, status: 'invalidated' as const };
      return receipt;
    });
    const released = state.receipts.filter((receipt) => receipt.batchId === id && receipt.status === 'queued').length;

    // 发件箱中该批次未执行的写入随版本变更失效（占位已释放）
    const outbox = state.outbox.filter((entry) => entry.batchId !== id);

    const batches = state.batches.map((item) => item.id === id
      ? { ...item, firmware, version: newVersion, updatedAt: at }
      : item);

    return {
      ...state,
      batches,
      receipts,
      outbox,
      notice: noticeOf('warn', `批次 ${batch.name} 升级到 v${newVersion}（固件 ${firmware}）：${released} 台未执行回执已失效并释放分组占位，已安装设备保留现场`),
      audits: audit(state, actor, `批次 ${id} 版本变更 v${batch.version} → v${newVersion}（固件 ${firmware}）：${released} 台未执行回执失效并释放占位，已安装设备保留现场`)
    };
  }),

  on(clearConflict, (state) => ({ ...state, conflict: null })),
  on(clearNotice, (state) => ({ ...state, notice: null })),
  on(clearRejectedOutbox, (state) => ({ ...state, outbox: state.outbox.filter((entry) => entry.status !== 'rejected') })),

  on(telemetryTick, (state) => {
    const at = new Date().toISOString();

    // 执行排队中的回执：每轮把若干 queued 置为 installed/failed
    let receipts = state.receipts;
    const queued = receipts.filter((receipt) => receipt.status === 'queued');
    if (queued.length) {
      const toExecute = new Set(queued.slice(0, 3).map((receipt) => receipt.id));
      receipts = receipts.map((receipt) => {
        if (!toExecute.has(receipt.id)) return receipt;
        if (receipt.result === 'failed') return { ...receipt, status: 'failed' as const, executedAt: at };
        return { ...receipt, status: 'installed' as const, executedAt: at };
      });
    }

    const batches = state.batches.map((batch) => {
      if (batch.status !== 'running') return batch;
      const group = state.groups.find((item) => item.id === batch.groupId);
      const target = Math.round((group?.count ?? 0) * batch.rolloutPercent / 100);
      const hasReceipts = receipts.some((receipt) => receipt.batchId === batch.id && receipt.status !== 'invalidated');

      let downloaded: number;
      let failed: number;
      if (hasReceipts) {
        const counts = batchReceiptCounts(receipts, batch.id);
        downloaded = counts.installed;
        failed = counts.failed;
      } else {
        // 无回执时保留模拟增长，保持演示活跃
        const increment = Math.max(4, Math.round(target * 0.055));
        downloaded = Math.min(target, batch.downloaded + increment);
        failed = batch.failed + (Math.random() < 0.08 ? 1 : 0);
      }

      const progress = target ? Math.round(downloaded / target * 100) : 0;
      const failureRate = downloaded ? failed / downloaded * 100 : 0;
      const status: ReleaseBatch['status'] = failureRate > batch.failureThreshold
        ? 'paused'
        : downloaded >= target
          ? 'completed'
          : 'running';
      return { ...batch, downloaded, failed, progress, status, updatedAt: at };
    });

    const overflow = batches.some((batch, index) => batch.status === 'paused' && state.batches[index]?.status === 'running');
    return {
      ...state,
      batches,
      receipts,
      audits: overflow ? audit(state, '系统', '失败率超过阈值，已自动暂停发布') : state.audits
    };
  })
);
