export type BatchStatus = 'draft' | 'approved' | 'running' | 'paused' | 'completed' | 'rolled_back';

export interface DeviceGroup {
  id: string;
  name: string;
  region: string;
  count: number;
  compatible: boolean;
  offlineGateways: number;
}

export interface ReleaseBatch {
  id: string;
  name: string;
  firmware: string;
  rollbackVersion: string;
  groupId: string;
  rolloutPercent: number;
  failureThreshold: number;
  status: BatchStatus;
  progress: number;
  downloaded: number;
  failed: number;
  /** 批次版本：回执提交与版本变更的乐观并发依据 */
  version: number;
  updatedAt: string;
}

/** 回执上报的安装结果 */
export type ReceiptResult = 'installed' | 'failed';
/**
 * 回执生命周期：
 * - queued     已登记入账、待执行（占用分组占位）
 * - installed  已执行：设备已安装（现场保留）
 * - failed     已执行：设备安装失败
 * - invalidated 批次版本变更后失效，不再计数，释放占位
 */
export type ReceiptStatus = 'queued' | 'installed' | 'failed' | 'invalidated';

export interface DeviceReceipt {
  /** 幂等键：${batchId}:${deviceId}，重复回执只算一次 */
  id: string;
  batchId: string;
  groupId: string;
  deviceId: string;
  /** 回执提交时针对的固件版本 */
  firmware: string;
  result: ReceiptResult;
  status: ReceiptStatus;
  /** 回执提交时批次的版本号 */
  batchVersion: number;
  submittedBy: string;
  submittedAt: string;
  executedAt?: string;
}

export interface PendingWriteItem {
  deviceId: string;
  groupId: string;
  result: ReceiptResult;
}

/**
 * 发件箱：分组写入失败后保留的待重试写入。
 * - pending  待重试
 * - rejected 批次已回滚，重试被永久拒绝（不得覆盖回滚）
 */
export type PendingWriteStatus = 'pending' | 'rejected';

export interface PendingWrite {
  id: string;
  batchId: string;
  items: PendingWriteItem[];
  actor: string;
  /** 写入时批次的版本号，重试时据此判断是否已过期 */
  expectedVersion: number;
  attempts: number;
  status: PendingWriteStatus;
  reason?: string;
  createdAt: string;
}

/** 乐观并发冲突报告：后到提交者看到的冲突设备与最新批次 */
export interface ConflictReport {
  batchId: string;
  batchName: string;
  expectedVersion: number;
  currentVersion: number;
  /** 已被先到回执登记、后到提交重复触碰的设备 */
  conflictingDevices: string[];
  latestFirmware: string;
  latestStatus: BatchStatus;
  message: string;
  at: string;
}

export interface Notice {
  type: 'success' | 'error' | 'warn';
  message: string;
  at: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  message: string;
}

export interface ReleaseState {
  groups: DeviceGroup[];
  batches: ReleaseBatch[];
  receipts: DeviceReceipt[];
  outbox: PendingWrite[];
  conflict: ConflictReport | null;
  notice: Notice | null;
  audits: AuditEntry[];
}
