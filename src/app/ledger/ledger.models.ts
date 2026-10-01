/**
 * 发布账（release ledger）领域模型。
 *
 * 账户把三件事连成一条流水：
 *  1. 设备分组（DeviceGroup）—— 提供容量；
 *  2. 发布批次（ReleaseBatch）—— 绑定分组、版本与账本版本号 revision；
 *  3. 设备回执（InstallReceipt）—— 每台设备一行流水，重复回执只落账一次。
 */

export type BatchStatus = 'draft' | 'approved' | 'running' | 'paused' | 'completed' | 'rolled_back';

/** 安装结果：回执上报时可以只有“已接收”，或直接带成功/失败结论 */
export type InstallResult = 'pending' | 'installed' | 'failed';

export interface DeviceGroup {
  id: string;
  name: string;
  region: string;
  count: number;
  compatible: boolean;
  offlineGateways: number;
}

export interface InstallReceipt {
  /** 回执唯一号，幂等键：同一个回执号永远只落账一次 */
  receiptId: string;
  /** 回执登记的顺序号，越大越新（同设备后到回执覆盖旧结论的判定依据） */
  seq: number;
  batchId: string;
  groupId: string;
  deviceId: string;
  /** 回执声称的目标版本；与批次当前版本不一致即为过期回执 */
  firmware: string;
  result: InstallResult;
  /** 回执上报时刻 */
  at: string;
  /**
   * 过期标记：批次版本变化后，旧版本且尚未执行（pending）的回执失效，
   * 释放分组占位；已执行（installed/failed）的回执保留现场，不被覆盖。
   */
  stale?: boolean;
  /** 被同设备同版本的最终结论回执替代（pending → installed/failed），不再计数 */
  supersededBy?: string;
}

export interface ReleaseBatch {
  id: string;
  name: string;
  /** 当前目标版本。版本变化即产生新账期，revision 递增 */
  firmware: string;
  rollbackVersion: string;
  /** 一个批次可同时占用多个设备分组 */
  groupIds: string[];
  rolloutPercent: number;
  failureThreshold: number;
  status: BatchStatus;
  /** 乐观并发版本号：后提交者必须能看到冲突设备和最新批次 */
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  message: string;
}

export interface ReleaseLedger {
  groups: DeviceGroup[];
  batches: ReleaseBatch[];
  /** 全部设备回执流水（只追加，重复回执不会产生第二行） */
  receipts: InstallReceipt[];
  audits: AuditEntry[];
  /** 最近一次提交回执的结果（冲突/部分失败提示给值班员），不持久化业务语义 */
  lastOutcome?: SubmitOutcome;
}

/** 提交到发布账的一批回执（两个值班员可能各交一份） */
export interface ReceiptInput {
  receiptId: string;
  groupId: string;
  deviceId: string;
  firmware: string;
  result?: InstallResult;
  at?: string;
}

/** 单个分组在当前账期（批次当前版本）下的容量与计数 */
export interface GroupRollout {
  groupId: string;
  capacity: number;
  installed: number;
  failed: number;
  pending: number;
  /** 占位 = 当前版本已执行 + 未执行的有效回执；stale 回执不占位 */
  occupied: number;
  free: number;
}

export interface BatchStats {
  groupRollouts: GroupRollout[];
  target: number;
  downloaded: number;
  installed: number;
  failed: number;
  pending: number;
  failureRate: number;
  progress: number;
  /** 版本变化后旧版本已安装、仍保留现场的设备数 */
  retained: number;
}

export type SubmitOutcome =
  | { kind: 'committed'; batchId: string; revision: number; applied: number; duplicates: string[]; overflow: string[]; staleRejected: string[]; wrongGroup: string[]; status: BatchStatus }
  | { kind: 'partial'; batchId: string; revision: number; applied: number; committedGroups: string[]; failedGroups: string[]; duplicates: string[]; overflow: string[]; staleRejected: string[]; wrongGroup: string[]; status: BatchStatus }
  | { kind: 'conflict'; batchId: string; expectedRevision: number; actualRevision: number; conflictDevices: string[]; currentFirmware: string; status: BatchStatus; retriable: ReceiptInput[] }
  | { kind: 'rejected'; batchId: string; reason: 'missing' | 'rolled_back' | 'draft' };
