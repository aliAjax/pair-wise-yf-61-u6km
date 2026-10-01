import type {
  BatchStats,
  DeviceGroup,
  GroupRollout,
  InstallReceipt,
  ReceiptInput,
  ReleaseBatch,
  ReleaseLedger,
  SubmitOutcome,
} from './ledger.models';

let seqWatermark = 0;
function nextSeq(): number {
  seqWatermark += 1;
  return Date.now() * 1000 + seqWatermark;
}

/** 分组在某账期的灰度容量 */
export function groupCapacity(group: DeviceGroup | undefined, percent: number): number {
  if (!group) return 0;
  return Math.round(group.count * percent / 100);
}

/**
 * 统计一个批次当前账期（batch.firmware 当前版本）的分组占位与计数。
 * 旧版本回执：已执行（installed/failed）保留现场但不占当前账期的位置；
 * pending 的旧版本回执已被标记 stale，同样不占位。
 */
export function summarizeBatch(batch: ReleaseBatch, groups: DeviceGroup[], receipts: InstallReceipt[]): BatchStats {
  const groupRollouts: GroupRollout[] = batch.groupIds.map((groupId) => {
    const group = groups.find((item) => item.id === groupId);
    const capacity = groupCapacity(group, batch.rolloutPercent);
    // 只统计当前账期（当前版本）且有效的回执；旧版本、stale、被替代的行均不占位
    const rows = receipts.filter(
      (r) => r.batchId === batch.id && r.groupId === groupId && !r.stale && !r.supersededBy && r.firmware === batch.firmware
    );
    const installed = rows.filter((r) => r.result === 'installed').length;
    const failed = rows.filter((r) => r.result === 'failed').length;
    const pending = rows.filter((r) => r.result === 'pending').length;
    const occupied = installed + failed + pending;
    return { groupId, capacity, installed, failed, pending, occupied, free: Math.max(0, capacity - occupied) };
  });

  const retained = receipts.filter(
    (r) => r.batchId === batch.id && r.firmware !== batch.firmware && r.result === 'installed' && !r.stale
  ).length;

  const target = groupRollouts.reduce((sum, item) => sum + item.capacity, 0);
  const installed = groupRollouts.reduce((sum, item) => sum + item.installed, 0);
  const failed = groupRollouts.reduce((sum, item) => sum + item.failed, 0);
  const pending = groupRollouts.reduce((sum, item) => sum + item.pending, 0);
  const downloaded = installed + failed + pending;
  const settled = installed + failed;
  return {
    groupRollouts,
    target,
    downloaded,
    installed,
    failed,
    pending,
    retained,
    failureRate: settled ? failed / settled * 100 : 0,
    progress: target ? Math.round(downloaded / target * 100) : 0,
  };
}

export interface SubmitContext {
  ledger: ReleaseLedger;
  batchId: string;
  actor: string;
  inputs: ReceiptInput[];
  /** 值班员提交时看到的批次账期；与当前 revision 不一致则整批乐观冲突 */
  expectedRevision?: number;
  /** 模拟按分组落账时失败（如分组网关写入超时），用于部分重试场景 */
  failGroups?: string[];
}

export interface SubmitResult {
  ledger: ReleaseLedger;
  outcome: SubmitOutcome;
}

/**
 * 提交一批回执到发布账。规则：
 * - 重复回执（同 receiptId）只算一次；
 * - 版本变化后，旧版本未执行（pending）回执失效（stale）并释放占位；
 *   旧版本已安装设备保留现场；
 * - 两个值班员同时提交：expectedRevision 落后者拿到冲突设备清单、最新版本与可重试回执；
 * - 部分分组写入失败：已完成分组保留，只重试未完成部分，重试不重复计数、不覆盖回滚。
 */
export function submitReceipts(ctx: SubmitContext): SubmitResult {
  const { ledger, batchId, actor, inputs } = ctx;
  const batch = ledger.batches.find((item) => item.id === batchId);

  if (!batch) {
    const outcome: SubmitOutcome = { kind: 'rejected', batchId, reason: 'missing' };
    return { ledger: { ...ledger, lastOutcome: outcome }, outcome };
  }
  if (batch.status === 'rolled_back') {
    const outcome: SubmitOutcome = { kind: 'rejected', batchId, reason: 'rolled_back' };
    return { ledger: { ...ledger, lastOutcome: outcome }, outcome };
  }
  if (batch.status === 'draft') {
    const outcome: SubmitOutcome = { kind: 'rejected', batchId, reason: 'draft' };
    return { ledger: { ...ledger, lastOutcome: outcome }, outcome };
  }

  // 乐观并发：后到者必须看到冲突设备与最新批次
  if (ctx.expectedRevision !== undefined && ctx.expectedRevision !== batch.revision) {
    const claimedByOther = new Set(
      ledger.receipts
        .filter((r) => r.batchId === batchId && inputs.some((i) => i.deviceId === r.deviceId))
        .map((r) => r.deviceId)
    );
    const knownReceipts = new Set(ledger.receipts.map((r) => r.receiptId));
    // 已登记过的回执号重试无意义，剔除；其余作为可重试条目原样返回
    const retriable = inputs.filter((i) => !knownReceipts.has(i.receiptId));
    const outcome: SubmitOutcome = {
      kind: 'conflict',
      batchId,
      expectedRevision: ctx.expectedRevision,
      actualRevision: batch.revision,
      conflictDevices: [...claimedByOther],
      currentFirmware: batch.firmware,
      status: batch.status,
      retriable,
    };
    return {
      ledger: { ...ledger, lastOutcome: outcome },
      outcome,
    };
  }

  const statsBefore = summarizeBatch(batch, ledger.groups, ledger.receipts);
  const freeByGroup = new Map(statsBefore.groupRollouts.map((item) => [item.groupId, item.free]));
  const knownIds = new Set(ledger.receipts.map((r) => r.receiptId));
  // 同设备在当前账期已有的最终结论，用于丢弃过期/重复设备回执
  const deviceRow = new Map(
    ledger.receipts
      .filter((r) => r.batchId === batchId && !r.stale && r.firmware === batch.firmware)
      .map((r) => [r.deviceId, r])
  );

  const duplicates: string[] = [];
  const overflow: string[] = [];
  const staleRejected: string[] = [];
  const wrongGroup: string[] = [];
  /** 接受的条目；replaces 指向被它替代的 pending 回执（占位顺延，不占新名额） */
  const accepted: { input: ReceiptInput; groupId: string; replaces?: InstallReceipt }[] = [];

  for (const input of inputs) {
    if (knownIds.has(input.receiptId)) {
      duplicates.push(input.receiptId);
      continue;
    }
    if (!batch.groupIds.includes(input.groupId)) {
      wrongGroup.push(input.deviceId);
      continue;
    }
    // 旧版本回执：版本已经变化，旧账期未执行的回执一律失效，不允许推进
    if (input.firmware !== batch.firmware) {
      staleRejected.push(input.deviceId);
      continue;
    }
    const existing = deviceRow.get(input.deviceId);
    if (existing) {
      // 同设备同版本：最终结论不被覆盖；pending 只能被一次最终结论替代
      if (existing.result !== 'pending' || (input.result ?? 'pending') === 'pending') {
        duplicates.push(input.receiptId);
        continue;
      }
      accepted.push({ input, groupId: input.groupId, replaces: existing });
      deviceRow.set(input.deviceId, {
        receiptId: input.receiptId,
        seq: nextSeq(),
        batchId,
        groupId: input.groupId,
        deviceId: input.deviceId,
        firmware: input.firmware,
        result: input.result ?? 'pending',
        at: input.at ?? new Date().toISOString(),
      });
      continue;
    }
    const free = freeByGroup.get(input.groupId) ?? 0;
    if (free <= 0) {
      overflow.push(input.deviceId);
      continue;
    }
    freeByGroup.set(input.groupId, free - 1);
    accepted.push({ input, groupId: input.groupId });
    deviceRow.set(input.deviceId, {
      receiptId: input.receiptId,
      seq: nextSeq(),
      batchId,
      groupId: input.groupId,
      deviceId: input.deviceId,
      firmware: input.firmware,
      result: input.result ?? 'pending',
      at: input.at ?? new Date().toISOString(),
    });
  }

  // 模拟按分组写入：某些分组写入失败时，已完成分组保留，失败分组整组不落账
  const failGroups = new Set(ctx.failGroups ?? []);
  const failedGroups = [...new Set(accepted.map((item) => item.groupId))].filter((id) => failGroups.has(id));
  const committedGroups = [...new Set(accepted.map((item) => item.groupId))].filter((id) => !failGroups.has(id));
  const committed = accepted.filter((item) => !failedGroups.includes(item.groupId));

  // 被成功提交的最终回执替代的 pending 行立即标记，计数永不重复
  const supersededIds = new Set(committed.filter((item) => item.replaces).map((item) => item.replaces!.receiptId));
  const newReceipts: InstallReceipt[] = committed.map((item) => ({
    receiptId: item.input.receiptId,
    seq: nextSeq(),
    batchId,
    groupId: item.groupId,
    deviceId: item.input.deviceId,
    firmware: item.input.firmware,
    result: item.input.result ?? 'pending',
    at: item.input.at ?? new Date().toISOString(),
  }));

  const receipts = [
    ...ledger.receipts.map((r) => (supersededIds.has(r.receiptId) ? { ...r, supersededBy: newReceipts.find((n) => n.deviceId === r.deviceId)?.receiptId } : r)),
    ...newReceipts,
  ];
  const updatedBatch: ReleaseBatch = {
    ...batch,
    revision: batch.revision + 1,
    updatedAt: new Date().toISOString(),
  };
  const stats = summarizeBatch(updatedBatch, ledger.groups, receipts);

  // 失败率超阈值自动暂停；不覆盖回滚（rolled_back 批次在入口已拒绝）
  let status = batch.status;
  if (status === 'running' && stats.target > 0 && stats.failureRate > batch.failureThreshold) {
    status = 'paused';
  } else if (status === 'running' && stats.target > 0 && stats.groupRollouts.every((g) => g.capacity > 0 && g.occupied >= g.capacity)) {
    status = 'completed';
  }

  const finalBatch: ReleaseBatch = { ...updatedBatch, status };
  const led: ReleaseLedger = {
    ...ledger,
    batches: ledger.batches.map((item) => (item.id === batchId ? finalBatch : item)),
    receipts,
  };

  const messages: string[] = [];
  if (newReceipts.length) messages.push(`登记 ${newReceipts.length} 台设备回执`);
  if (duplicates.length) messages.push(`${duplicates.length} 条重复回执只计一次`);
  if (overflow.length) messages.push(`${overflow.length} 台超出分组占位被拒`);
  if (staleRejected.length) messages.push(`${staleRejected.length} 台旧版本回执失效`);
  if (wrongGroup.length) messages.push(`${wrongGroup.length} 台不属于本批次分组`);
  if (failedGroups.length) messages.push(`分组 ${failedGroups.join('、')} 写入失败待重试`);
  if (status === 'paused' && batch.status === 'running') messages.push('失败率超过阈值，已自动暂停发布');
  if (status === 'completed' && batch.status !== 'completed') messages.push('全部占位登记完成');

  led.audits = [
    { id: crypto.randomUUID(), at: new Date().toISOString(), actor, message: `批次 ${batch.name}：${messages.join('，') || '无有效回执'}` },
    ...ledger.audits,
  ];

  const common = {
    batchId,
    revision: finalBatch.revision,
    duplicates,
    overflow,
    staleRejected,
    wrongGroup,
    status: finalBatch.status,
  };

  const outcome: SubmitOutcome = failedGroups.length
    ? {
        kind: 'partial',
        ...common,
        applied: newReceipts.length,
        committedGroups,
        failedGroups,
      }
    : { kind: 'committed', ...common, applied: newReceipts.length };

  led.lastOutcome = outcome;
  return { ledger: led, outcome };
}

/**
 * 批次版本变化（重新发布到新版本）：
 * 旧版本未执行回执标记 stale 并立即释放分组占位；
 * 旧版本已安装/失败设备保留现场（只在统计中作为 retained 展示）。
 */
export function retargetBatch(
  ledger: ReleaseLedger,
  batchId: string,
  firmware: string,
  actor: string
): ReleaseLedger {
  const batch = ledger.batches.find((item) => item.id === batchId);
  if (!batch || firmware === batch.firmware) return ledger;

  let released = 0;
  const receipts = ledger.receipts.map((r) => {
    if (r.batchId !== batchId || r.stale || r.firmware !== batch.firmware) return r;
    if (r.result === 'pending') {
      released += 1;
      return { ...r, stale: true };
    }
    // installed/failed 保留现场，不覆盖
    return r;
  });

  const updated: ReleaseBatch = {
    ...batch,
    firmware,
    status: 'draft',
    revision: batch.revision + 1,
    updatedAt: new Date().toISOString(),
  };

  return {
    ...ledger,
    batches: ledger.batches.map((item) => (item.id === batchId ? updated : item)),
    receipts,
    audits: [
      {
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        actor,
        message: `批次 ${batch.name} 目标版本 ${batch.firmware} → ${firmware}：${released} 条旧版本未执行回执失效并释放占位，已安装设备保留现场`,
      },
      ...ledger.audits,
    ],
  };
}

/** 回滚：登记回滚结论但绝不覆盖已安装现场之外的推进结果；回滚后任何回执都被拒绝 */
export function markRolledBack(ledger: ReleaseLedger, batchId: string, actor: string): ReleaseLedger {
  const batch = ledger.batches.find((item) => item.id === batchId);
  if (!batch || batch.status === 'rolled_back') return ledger;
  return {
    ...ledger,
    batches: ledger.batches.map((item) =>
      item.id === batchId ? { ...item, status: 'rolled_back', revision: item.revision + 1, updatedAt: new Date().toISOString() } : item
    ),
    audits: [
      { id: crypto.randomUUID(), at: new Date().toISOString(), actor, message: `批次 ${batch.name} 已紧急回滚，后续回执一律拒收，已安装设备现场保留` },
      ...ledger.audits,
    ],
  };
}
