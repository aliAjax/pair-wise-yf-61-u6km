import { createFeatureSelector, createSelector } from '@ngrx/store';
import type { ReleaseState } from './release.models';

export const selectRelease = createFeatureSelector<ReleaseState>('release');
export const selectGroups = createSelector(selectRelease, (state) => state.groups);
export const selectBatches = createSelector(selectRelease, (state) => state.batches);
export const selectAudits = createSelector(selectRelease, (state) => state.audits);
export const selectReceipts = createSelector(selectRelease, (state) => state.receipts);
export const selectOutbox = createSelector(selectRelease, (state) => state.outbox);
export const selectConflict = createSelector(selectRelease, (state) => state.conflict);
export const selectNotice = createSelector(selectRelease, (state) => state.notice);

export const selectBatchById = (batchId: string) =>
  createSelector(selectBatches, (batches) => batches.find((batch) => batch.id === batchId));

export const selectReceiptsForBatch = (batchId: string) =>
  createSelector(selectReceipts, (receipts) => receipts.filter((receipt) => receipt.batchId === batchId));

export const selectOutboxPendingCount = createSelector(
  selectOutbox,
  (outbox) => outbox.filter((entry) => entry.status === 'pending').length
);

export const selectOutboxRejectedCount = createSelector(
  selectOutbox,
  (outbox) => outbox.filter((entry) => entry.status === 'rejected').length
);
