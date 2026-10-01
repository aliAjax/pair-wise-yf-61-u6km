export type {
  AuditEntry,
  BatchStats,
  BatchStatus,
  DeviceGroup,
  GroupRollout,
  InstallReceipt,
  InstallResult,
  ReceiptInput,
  ReleaseBatch,
  ReleaseLedger,
  SubmitOutcome,
} from '../ledger/ledger.models';

import type { ReleaseLedger } from '../ledger/ledger.models';

export type ReleaseState = ReleaseLedger;
