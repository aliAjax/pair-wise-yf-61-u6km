import { createFeatureSelector, createSelector } from '@ngrx/store';
import type { BatchStats, ReleaseState } from './release.models';
import { summarizeBatch } from '../ledger/ledger';

export const selectRelease = createFeatureSelector<ReleaseState>('release');
export const selectGroups = createSelector(selectRelease, (state) => state.groups);
export const selectBatches = createSelector(selectRelease, (state) => state.batches);
export const selectReceipts = createSelector(selectRelease, (state) => state.receipts);
export const selectAudits = createSelector(selectRelease, (state) => state.audits);
export const selectLastOutcome = createSelector(selectRelease, (state) => state.lastOutcome);

/** 每个批次附带当前账期的分组占位与计数（由发布账纯函数算出） */
export const selectBatchViews = createSelector(selectRelease, (state) =>
  state.batches.map((batch) => ({
    batch,
    stats: summarizeBatch(batch, state.groups, state.receipts) as BatchStats,
    groups: batch.groupIds
      .map((id) => state.groups.find((g) => g.id === id))
      .filter((g): g is NonNullable<typeof g> => !!g),
  }))
);

export const selectReceiptLedger = createSelector(selectRelease, (state) =>
  [...state.receipts].sort((a, b) => b.seq - a.seq).slice(0, 60)
);
