import { createAction, props } from '@ngrx/store';
import type { ReceiptInput } from './release.models';

export const createBatch = createAction(
  '[Release] Create batch',
  props<{ name: string; firmware: string; rollbackVersion: string; groupIds: string[]; rolloutPercent: number; failureThreshold: number }>()
);
export const approveBatch = createAction('[Release] Approve batch', props<{ id: string; actor: string }>());
export const pauseBatch = createAction('[Release] Pause batch', props<{ id: string; actor: string }>());
export const resumeBatch = createAction('[Release] Resume batch', props<{ id: string; actor: string }>());
export const rollbackBatch = createAction('[Release] Rollback batch', props<{ id: string; actor: string }>());
export const retargetBatchVersion = createAction('[Release] Retarget batch firmware', props<{ id: string; firmware: string; actor: string }>());

/** 值班员提交一批设备回执；expectedRevision 实现双人并发的乐观锁 */
export const submitReceipts = createAction(
  '[Release] Submit receipts',
  props<{ batchId: string; actor: string; inputs: ReceiptInput[]; expectedRevision?: number; failGroups?: string[] }>()
);
export const clearOutcome = createAction('[Release] Clear last outcome');

/** 本地模拟：离线设备晚到的安装回执 */
export const simulateLateReceipt = createAction('[Release] Simulate late receipt');
