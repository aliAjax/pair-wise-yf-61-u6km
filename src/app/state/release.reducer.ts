import { createReducer, on } from '@ngrx/store';
import type { DeviceGroup, ReceiptInput, ReleaseBatch, ReleaseState } from './release.models';
import {
  approveBatch,
  clearOutcome,
  createBatch,
  pauseBatch,
  resumeBatch,
  retargetBatchVersion,
  rollbackBatch,
  simulateLateReceipt,
  submitReceipts,
} from './release.actions';
import { markRolledBack, retargetBatch, submitReceipts as applyReceipts } from '../ledger/ledger';

const initialGroups: DeviceGroup[] = [
  { id: 'g-edge', name: '华东边缘网关', region: '华东', count: 100, compatible: true, offlineGateways: 4 },
  { id: 'g-clinic', name: '远程诊疗终端', region: '新加坡', count: 50, compatible: true, offlineGateways: 2 },
  { id: 'g-plant', name: '工业采集终端', region: '华南', count: 1240, compatible: false, offlineGateways: 12 },
];
const now = new Date().toISOString();
const initialBatches: ReleaseBatch[] = [
  {
    id: 'batch-demo',
    name: '边缘网关安全补丁 2.8.1',
    firmware: '2.8.1',
    rollbackVersion: '2.7.9',
    groupIds: ['g-edge', 'g-clinic'],
    rolloutPercent: 20,
    failureThreshold: 30,
    status: 'running',
    revision: 3,
    createdAt: now,
    updatedAt: now,
  },
];
const initialAudits = [{ id: 'audit-1', at: now, actor: '运维值班', message: '批次 batch-demo 完成兼容性检查并开始发布，占用华东边缘网关与远程诊疗终端分组' }];

/** v2 发布账：旧版 localStorage（无 receipts）不再复用，避免脏数据 */
const STORAGE_KEY = 'firmware-release-ledger-v2';
const fallback: ReleaseState = { groups: initialGroups, batches: initialBatches, receipts: [], audits: initialAudits };
const stored = typeof localStorage === 'undefined'
  ? null
  : JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as ReleaseState | null;
const initialState: ReleaseState = stored && Array.isArray(stored.receipts) ? stored : fallback;

function auditEntry(actor: string, message: string) {
  return { id: crypto.randomUUID(), at: new Date().toISOString(), actor, message };
}

function patchBatch(state: ReleaseState, id: string, patch: Partial<ReleaseBatch>, actor: string, message: string): ReleaseState {
  return {
    ...state,
    batches: state.batches.map((batch) => (batch.id === id ? { ...batch, ...patch, updatedAt: new Date().toISOString() } : batch)),
    audits: [auditEntry(actor, message), ...state.audits],
  };
}

/** 模拟一张离线设备晚到的回执：从 running/paused 批次占满名额前的空闲位置取设备 */
function buildLateReceipt(state: ReleaseState): { batchId: string; actor: string; inputs: ReceiptInput[]; failGroups?: string[] } | null {
  const batch = state.batches.find((item) => item.status === 'running' || item.status === 'paused');
  if (!batch) return null;
  const groupId = batch.groupIds[Math.floor(Math.random() * batch.groupIds.length)];
  const capacity = Math.round((state.groups.find((g) => g.id === groupId)?.count ?? 0) * batch.rolloutPercent / 100);
  const used = new Set(
    state.receipts
      .filter((r) => r.batchId === batch.id && r.groupId === groupId && r.firmware === batch.firmware && !r.stale && !r.supersededBy)
      .map((r) => r.deviceId)
  );
  const freeSlots = capacity - used.size;
  // 1/4 概率模拟该分组写入失败，值班员随后可点“重试未完成分组”
  const failGroups = freeSlots > 0 && Math.random() < 0.25 ? [groupId] : undefined;
  let deviceId: string | null = null;
  for (let i = 1; i <= capacity; i += 1) {
    const candidate = `${groupId}-dev-${String(i).padStart(3, '0')}`;
    if (!used.has(candidate)) { deviceId = candidate; break; }
  }
  if (!deviceId) return null;
  const failed = Math.random() < 0.12;
  return {
    batchId: batch.id,
    actor: '离线设备回执',
    failGroups,
    inputs: [{
      receiptId: `rcp-${crypto.randomUUID()}`,
      groupId,
      deviceId,
      firmware: batch.firmware,
      result: failed ? 'failed' : 'installed',
    }],
  };
}

export const releaseReducer = createReducer(
  initialState,
  on(createBatch, (state, p) => {
    const batch: ReleaseBatch = {
      id: crypto.randomUUID(),
      name: p.name,
      firmware: p.firmware,
      rollbackVersion: p.rollbackVersion,
      groupIds: p.groupIds,
      rolloutPercent: p.rolloutPercent,
      failureThreshold: p.failureThreshold,
      status: 'draft',
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return { ...state, batches: [batch, ...state.batches], audits: [auditEntry('发布负责人', `创建批次 ${p.name}，版本 ${p.firmware}，占用分组 ${p.groupIds.join('、')}`), ...state.audits] };
  }),
  on(approveBatch, (state, { id, actor }) => {
    const batch = state.batches.find((item) => item.id === id);
    if (!batch || batch.status !== 'draft') return state;
    return patchBatch(state, id, { status: 'approved' }, actor, `批次 ${id} 审批通过`);
  }),
  on(pauseBatch, (state, { id, actor }) => {
    const batch = state.batches.find((item) => item.id === id);
    if (!batch || (batch.status !== 'running' && batch.status !== 'approved')) return state;
    return patchBatch(state, id, { status: 'paused' }, actor, `批次 ${id} 已暂停，后续回执只登记现场不推进状态`);
  }),
  on(resumeBatch, (state, { id, actor }) => {
    const batch = state.batches.find((item) => item.id === id);
    if (!batch || (batch.status !== 'paused' && batch.status !== 'approved')) return state;
    return patchBatch(state, id, { status: 'running' }, actor, `批次 ${id} 恢复发布`);
  }),
  on(rollbackBatch, (state, { id, actor }) => markRolledBack(state, id, actor)),
  on(retargetBatchVersion, (state, { id, firmware, actor }) => retargetBatch(state, id, firmware, actor)),
  on(submitReceipts, (state, p) => applyReceipts({
    ledger: { ...state, lastOutcome: undefined },
    batchId: p.batchId,
    actor: p.actor,
    inputs: p.inputs,
    expectedRevision: p.expectedRevision,
    failGroups: p.failGroups,
  }).ledger),
  on(clearOutcome, (state) => ({ ...state, lastOutcome: undefined })),
  on(simulateLateReceipt, (state) => {
    const request = buildLateReceipt(state);
    if (!request) return state;
    return applyReceipts({ ledger: state, ...request }).ledger;
  })
);
