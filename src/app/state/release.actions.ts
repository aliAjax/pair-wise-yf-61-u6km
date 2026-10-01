import { createAction, props } from '@ngrx/store';
import type { ReleaseBatch, ReceiptResult } from './release.models';

export const createBatch = createAction('[Release] Create batch', props<{ batch: ReleaseBatch }>());
export const approveBatch = createAction('[Release] Approve batch', props<{ id: string; actor: string }>());
export const pauseBatch = createAction('[Release] Pause batch', props<{ id: string; actor: string }>());
export const resumeBatch = createAction('[Release] Resume batch', props<{ id: string; actor: string }>());
export const rollbackBatch = createAction('[Release] Rollback batch', props<{ id: string; actor: string }>());
export const telemetryTick = createAction('[Release] Telemetry tick');

/** 发布账：登记设备安装回执 */
export interface ReceiptItemInput {
  deviceId: string;
  groupId: string;
  result: ReceiptResult;
}
export const submitReceipts = createAction(
  '[Release] Submit receipts',
  props<{
    batchId: string;
    items: ReceiptItemInput[];
    actor: string;
    /** 提交时操作员看到的批次版本（乐观并发依据） */
    expectedVersion: number;
    /** 模拟对方值班员已抢先提交：使用过期版本触发冲突 */
    simulateConcurrent?: boolean;
    /** 模拟分组写入失败：首个分组写入失败进入发件箱 */
    forceFailure?: boolean;
  }>()
);

/** 发布账：重试发件箱中未完成的分组写入 */
export const retryOutbox = createAction('[Release] Retry outbox', props<{ actor: string }>());

/** 发布账：批次版本变更（固件升级），未执行回执失效并释放占位 */
export const changeBatchVersion = createAction(
  '[Release] Change batch version',
  props<{ id: string; firmware: string; actor: string }>()
);

export const clearConflict = createAction('[Release] Clear conflict');
export const clearNotice = createAction('[Release] Clear notice');
export const clearRejectedOutbox = createAction('[Release] Clear rejected outbox');
