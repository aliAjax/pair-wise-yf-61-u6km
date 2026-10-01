import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Store } from '@ngrx/store';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatDividerModule } from '@angular/material/divider';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatTableModule } from '@angular/material/table';
import { TranslocoPipe } from '@jsverse/transloco';
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
  retryOutbox,
  submitReceipts,
  telemetryTick
} from './state/release.actions';
import {
  selectAudits,
  selectBatches,
  selectConflict,
  selectGroups,
  selectNotice,
  selectOutbox,
  selectReceipts,
  selectRelease
} from './state/release.selectors';
import type { DeviceGroup, DeviceReceipt, PendingWrite, ReceiptResult, ReleaseBatch } from './state/release.models';

interface ReceiptRow {
 groupId: string;
 deviceNum: number;
 result: ReceiptResult;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, ScrollingModule, MatButtonModule, MatCardModule, MatChipsModule, MatDividerModule, MatFormFieldModule, MatInputModule, MatProgressBarModule, MatSelectModule, MatTableModule, TranslocoPipe],
  template: `
    <header class="hero">
      <div><span class="eyebrow">OTA LEDGER</span><h1>{{ 'title' | transloco }}</h1><p>{{ 'subtitle' | transloco }}</p></div>
      <mat-chip-set><mat-chip highlighted>回执幂等去重</mat-chip><mat-chip>版本并发控制</mat-chip><mat-chip>失败重试不覆盖回滚</mat-chip></mat-chip-set>
    </header>

    <main>
      @if (notice$ | async; as notice) {
        <div class="notice" [class]="notice.type">
          <span>{{ notice.message }}</span>
          <button mat-button (click)="clearNotice()">知道了</button>
        </div>
      }

      @if (conflict$ | async; as conflict) {
        <mat-card appearance="outlined" class="conflict">
          <mat-card-header><mat-card-title>并发冲突：后到回执被拒绝</mat-card-title></mat-card-header>
          <mat-card-content>
            <p>{{ conflict.message }}</p>
            <p>冲突设备（已被先到回执登记）：
              @for (device of conflict.conflictingDevices; track device) {
                <mat-chip class="conflict-chip">{{ device }}</mat-chip>
              } @empty { <span class="muted">无</span> }
            </p>
            <p class="muted">最新批次：{{ conflict.batchName }} · v{{ conflict.currentVersion }} · {{ conflict.latestFirmware }} · {{ conflict.latestStatus }}</p>
            <button mat-flat-button color="primary" (click)="clearConflict()">我已知晓，按最新批次处理</button>
          </mat-card-content>
        </mat-card>
      }

      <section class="stats">
        <mat-card appearance="outlined"><span>批次数</span><strong>{{ (batches$ | async)?.length ?? 0 }}</strong></mat-card>
        <mat-card appearance="outlined"><span>兼容分组</span><strong>{{ compatibleCount() }}</strong></mat-card>
        <mat-card appearance="outlined"><span>已暂停</span><strong>{{ pausedCount() }}</strong></mat-card>
        <mat-card appearance="outlined"><span>待重试写入</span><strong>{{ (outbox$ | async)?.length ?? 0 }}</strong></mat-card>
      </section>

      <section class="grid">
        <mat-card appearance="outlined">
          <mat-card-header><mat-card-title>{{ 'newBatch' | transloco }}</mat-card-title></mat-card-header>
          <mat-card-content class="form-grid">
            <mat-form-field><mat-label>批次名称</mat-label><input matInput [(ngModel)]="draft.name"></mat-form-field>
            <mat-form-field><mat-label>目标版本</mat-label><input matInput [(ngModel)]="draft.firmware"></mat-form-field>
            <mat-form-field><mat-label>回滚版本</mat-label><input matInput [(ngModel)]="draft.rollbackVersion"></mat-form-field>
            <mat-form-field><mat-label>设备分组</mat-label><mat-select [(ngModel)]="draft.groupId"><mat-option *ngFor="let group of groups$ | async" [value]="group.id" [disabled]="!group.compatible">{{ group.name }} · {{ group.region }}</mat-option></mat-select></mat-form-field>
            <mat-form-field><mat-label>灰度比例 %</mat-label><input matInput type="number" [(ngModel)]="draft.rolloutPercent"></mat-form-field>
            <mat-form-field><mat-label>失败阈值 %</mat-label><input matInput type="number" [(ngModel)]="draft.failureThreshold"></mat-form-field>
            <button mat-flat-button color="primary" (click)="create()">创建兼容批次</button>
          </mat-card-content>
        </mat-card>

        <mat-card appearance="outlined" class="batch-panel">
          <mat-card-header><mat-card-title>{{ 'batches' | transloco }}</mat-card-title></mat-card-header>
          <mat-card-content>
            <cdk-virtual-scroll-viewport itemSize="150" class="viewport">
              <article class="batch" *cdkVirtualFor="let batch of batches$ | async">
                <div class="row"><div><b>{{ batch.name }}</b><small>{{ batch.firmware }} → 回滚 {{ batch.rollbackVersion }}</small></div><mat-chip [color]="batch.status === 'paused' || batch.status === 'rolled_back' ? 'warn' : 'primary'" highlighted>{{ batch.status }} · v{{ batch.version }}</mat-chip></div>
                <mat-progress-bar mode="determinate" [value]="batch.progress"></mat-progress-bar>
                <div class="row"><span>{{ batch.downloaded }} 台已更新 · 失败 {{ batch.failed }} · 阈值 {{ batch.failureThreshold }}%</span><span>{{ batch.progress }}%</span></div>
                <div class="actions">
                  <button mat-stroked-button *ngIf="batch.status === 'draft'" (click)="approve(batch.id)">审批</button>
                  <button mat-stroked-button *ngIf="batch.status === 'approved'" (click)="resume(batch.id)">开始发布</button>
                  <button mat-stroked-button *ngIf="batch.status === 'running'" (click)="pause(batch.id)">暂停</button>
                  <button mat-stroked-button *ngIf="batch.status === 'paused'" (click)="resume(batch.id)">继续</button>
                  <button mat-flat-button color="warn" [disabled]="batch.status === 'completed' || batch.status === 'rolled_back'" (click)="rollback(batch.id)">紧急回滚</button>
                </div>
              </article>
            </cdk-virtual-scroll-viewport>
          </mat-card-content>
        </mat-card>
      </section>

      <mat-card appearance="outlined">
        <mat-card-header><mat-card-title>登记安装回执（发布账）</mat-card-title></mat-card-header>
        <mat-card-content>
          <div class="receipt-form">
            <mat-form-field><mat-label>选择批次</mat-label>
              <mat-select [(ngModel)]="receiptDraft.batchId">
                <mat-option *ngFor="let batch of batches$ | async" [value]="batch.id">{{ batch.name }} · v{{ batch.version }} · {{ batch.status }}</mat-option>
              </mat-select>
            </mat-form-field>
            <div class="rows">
              @for (row of receiptDraft.rows; track $index) {
                <div class="receipt-row">
                  <mat-form-field><mat-label>设备分组</mat-label>
                    <mat-select [(ngModel)]="row.groupId">
                      <mat-option *ngFor="let group of groups$ | async" [value]="group.id">{{ group.name }}</mat-option>
                    </mat-select>
                  </mat-form-field>
                  <mat-form-field><mat-label>设备编号</mat-label><input matInput type="number" min="0" [(ngModel)]="row.deviceNum"></mat-form-field>
                  <mat-form-field><mat-label>安装结果</mat-label>
                    <mat-select [(ngModel)]="row.result">
                      <mat-option value="installed">installed 已安装</mat-option>
                      <mat-option value="failed">failed 失败</mat-option>
                    </mat-select>
                  </mat-form-field>
                  <button mat-stroked-button color="warn" (click)="removeRow($index)" [disabled]="receiptDraft.rows.length === 1">删除</button>
                </div>
              }
            </div>
            <div class="row-actions">
              <button mat-stroked-button (click)="addRow()">添加一行</button>
              <button mat-stroked-button (click)="quickAdd()">按兼容分组各加一台</button>
            </div>
            <div class="flags">
              <label><input type="checkbox" [(ngModel)]="receiptDraft.simulateConcurrent"> 模拟并发冲突（对方值班员已抢先提交，本方使用过期版本）</label>
              <label><input type="checkbox" [(ngModel)]="receiptDraft.forceFailure"> 模拟分组写入失败（首个分组失败进入发件箱）</label>
            </div>
            <button mat-flat-button color="primary" (click)="submitReceipts()">提交回执（幂等入账）</button>
          </div>
          <mat-divider></mat-divider>
          <div class="version-form">
            <b>批次版本变更</b>
            <mat-form-field><mat-label>新固件版本</mat-label><input matInput [(ngModel)]="versionDraft.firmware"></mat-form-field>
            <button mat-stroked-button (click)="changeVersion()">升级版本（未执行回执失效并释放占位，已安装保留现场）</button>
          </div>
        </mat-card-content>
      </mat-card>

      <mat-card appearance="outlined">
        <mat-card-header><mat-card-title>发件箱（写入失败待重试）</mat-card-title></mat-card-header>
        <mat-card-content>
          @if (outbox$ | async; as outbox) {
            @if (outbox.length === 0) { <p class="muted">发件箱为空。分组写入失败后，未完成的分组会保留在这里，重试只补写未完成部分。</p> }
            @for (entry of outbox; track entry.id) {
              <div class="outbox-item" [class.rejected]="entry.status === 'rejected'">
                <div class="row">
                  <b>批次 {{ entry.batchId }}</b>
                  <mat-chip [color]="entry.status === 'rejected' ? 'warn' : 'accent'" highlighted>{{ entry.status === 'rejected' ? '已拒绝' : '待重试' }}</mat-chip>
                </div>
                <p class="muted">分组 {{ groupNames(entry) }} · {{ entry.items.length }} 台 · 提交于 v{{ entry.expectedVersion }} · 重试 {{ entry.attempts }} 次 · {{ entry.actor }}</p>
                @if (entry.reason) { <p class="muted">原因：{{ entry.reason }}</p> }
              </div>
            }
            @if (outbox.length) {
              <div class="row-actions">
                <button mat-flat-button color="primary" (click)="retryOutbox()">重试发件箱（只补写未完成部分）</button>
                <button mat-stroked-button (click)="clearRejected()">清理已拒绝</button>
              </div>
            }
          }
        </mat-card-content>
      </mat-card>

      <mat-card appearance="outlined">
        <mat-card-header><mat-card-title>回执台账</mat-card-title></mat-card-header>
        <mat-card-content>
          @if (receipts$ | async; as receipts) {
            @if (receipts.length === 0) { <p class="muted">暂无回执。</p> }
            @else {
              <table mat-table [dataSource]="receipts" class="ledger">
                <ng-container matColumnDef="device"><th mat-header-cell *matHeaderCellDef>设备</th><td mat-cell *matCellDef="let r">{{ r.deviceId }}</td></ng-container>
                <ng-container matColumnDef="group"><th mat-header-cell *matHeaderCellDef>分组</th><td mat-cell *matCellDef="let r">{{ r.groupId }}</td></ng-container>
                <ng-container matColumnDef="result"><th mat-header-cell *matHeaderCellDef>上报结果</th><td mat-cell *matCellDef="let r">{{ r.result }}</td></ng-container>
                <ng-container matColumnDef="status"><th mat-header-cell *matHeaderCellDef>状态</th><td mat-cell *matCellDef="let r"><mat-chip [color]="receiptColor(r.status)" highlighted>{{ r.status }}</mat-chip></td></ng-container>
                <ng-container matColumnDef="version"><th mat-header-cell *matHeaderCellDef>版本</th><td mat-cell *matCellDef="let r">v{{ r.batchVersion }}</td></ng-container>
                <ng-container matColumnDef="actor"><th mat-header-cell *matHeaderCellDef>提交人</th><td mat-cell *matCellDef="let r">{{ r.submittedBy }}</td></ng-container>
                <ng-container matColumnDef="time"><th mat-header-cell *matHeaderCellDef>时间</th><td mat-cell *matCellDef="let r">{{ r.submittedAt | date:'MM-dd HH:mm:ss' }}</td></ng-container>
                <tr mat-header-row *matHeaderRowDef="['device','group','result','status','version','actor','time']"></tr>
                <tr mat-row *matRowDef="let row; columns: ['device','group','result','status','version','actor','time']"></tr>
              </table>
            }
          }
        </mat-card-content>
      </mat-card>

      <mat-card appearance="outlined">
        <mat-card-header><mat-card-title>{{ 'audit' | transloco }}</mat-card-title></mat-card-header>
        <mat-card-content class="audit-list"><div class="audit" *ngFor="let item of audits$ | async"><span>{{ item.at | date:'MM-dd HH:mm:ss' }}</span><b>{{ item.actor }}</b><p>{{ item.message }}</p></div></mat-card-content>
      </mat-card>
    </main>
  `,
  styles: [`
    :host { display:block; min-height:100vh; background:#edf4f5; }
    .hero { padding:36px max(24px,6vw) 28px; color:#fff; background:linear-gradient(125deg,#053b46,#0f6f6c 62%,#2a9d8f); display:flex; justify-content:space-between; gap:24px; align-items:end; }
    .hero h1 { margin:8px 0; font-size:clamp(30px,4vw,52px); letter-spacing:-.04em; } .hero p { margin:0; opacity:.8 } .eyebrow { letter-spacing:.2em; font-size:12px; opacity:.7 }
    main { padding:22px max(18px,5vw) 60px; display:grid; gap:20px; } .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:16px; } .stats span { display:block;color:#607d86 } .stats strong { font-size:30px }
    .grid { display:grid; grid-template-columns:minmax(300px,.8fr) minmax(420px,1.2fr); gap:20px; } .form-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; padding-top:16px }
    .viewport { height:540px; } .batch { min-height:132px; border-bottom:1px solid #dde7e8; padding:12px 4px; display:grid; gap:10px } .row { display:flex;justify-content:space-between;gap:12px;align-items:center } small { display:block;color:#71858c } .actions { display:flex;gap:8px;flex-wrap:wrap }
    .audit-list { max-height:320px; overflow:auto } .audit { display:grid;grid-template-columns:120px 110px 1fr;border-bottom:1px solid #e5ecee;padding:10px 4px } .audit p { margin:0 }
    .notice { display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-radius:8px;background:#fff;border-left:4px solid #2a9d8f } .notice.error { border-left-color:#c62828 } .notice.warn { border-left-color:#f9a825 }
    .conflict { border-left:4px solid #c62828 } .conflict-chip { margin-right:6px } .muted { color:#71858c }
    .receipt-form { display:grid;gap:12px;padding-top:12px } .rows { display:grid;gap:8px } .receipt-row { display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:8px;align-items:center }
    .row-actions { display:flex;gap:8px;flex-wrap:wrap } .flags { display:grid;gap:6px;color:#455a64;font-size:14px } .flags label { display:flex;gap:8px;align-items:center }
    .version-form { display:flex;gap:12px;align-items:center;margin-top:16px;flex-wrap:wrap } .version-form b { color:#37474f }
    .outbox-item { border:1px solid #dde7e8;border-radius:8px;padding:10px 12px;margin-bottom:8px;background:#fafdfd } .outbox-item.rejected { background:#fff5f5;border-color:#ef9a9a }
    .ledger { width:100% }
    @media(max-width:900px){ .hero{align-items:flex-start;flex-direction:column}.stats{grid-template-columns:1fr 1fr}.grid{grid-template-columns:1fr}.form-grid{grid-template-columns:1fr}.audit{grid-template-columns:1fr}.viewport{height:400px}.receipt-row{grid-template-columns:1fr}.version-form{flex-direction:column;align-items:stretch} }
  `]
})
export class AppComponent implements OnInit, OnDestroy {
  private readonly store = inject(Store);
  readonly groups$ = this.store.select(selectGroups);
  readonly batches$ = this.store.select(selectBatches);
  readonly audits$ = this.store.select(selectAudits);
  readonly receipts$ = this.store.select(selectReceipts);
  readonly outbox$ = this.store.select(selectOutbox);
  readonly conflict$ = this.store.select(selectConflict);
  readonly notice$ = this.store.select(selectNotice);
  private timer?: number;
  private groups: DeviceGroup[] = [];
  private batches: ReleaseBatch[] = [];

  draft = { name: '', firmware: '3.0.0', rollbackVersion: '2.9.2', groupId: 'g-edge', rolloutPercent: 10, failureThreshold: 3 };
  receiptDraft: { batchId: string; rows: ReceiptRow[]; simulateConcurrent: boolean; forceFailure: boolean } = {
    batchId: 'batch-demo',
    rows: [{ groupId: 'g-edge', deviceNum: 0, result: 'installed' }],
    simulateConcurrent: false,
    forceFailure: false
  };
  versionDraft = { firmware: '3.1.0' };

  ngOnInit() {
    this.timer = window.setInterval(() => this.store.dispatch(telemetryTick()), 1400);
    this.groups$.subscribe((groups) => (this.groups = groups));
    this.batches$.subscribe((batches) => (this.batches = batches));
    this.store.select(selectRelease).subscribe((state) => {
      localStorage.setItem('firmware-release-v2', JSON.stringify({
        groups: state.groups,
        batches: state.batches,
        receipts: state.receipts,
        outbox: state.outbox,
        audits: state.audits
      }));
    });
  }
  ngOnDestroy() { if (this.timer) window.clearInterval(this.timer); }

  pausedCount() { let count = 0; this.batches$.subscribe((items) => count = items.filter((item) => item.status === 'paused').length); return count; }
  compatibleCount() { return this.groups.filter((group) => group.compatible).length; }

  create() {
    if (!this.draft.name || !this.draft.firmware || !this.draft.groupId) return;
    const batch: ReleaseBatch = { ...this.draft, id: crypto.randomUUID(), status: 'draft', progress: 0, downloaded: 0, failed: 0, version: 1, updatedAt: new Date().toISOString() };
    this.store.dispatch(createBatch({ batch }));
    this.draft = { ...this.draft, name: '' };
  }
  approve(id: string) { this.store.dispatch(approveBatch({ id, actor: '发布负责人' })); }
  pause(id: string) { this.store.dispatch(pauseBatch({ id, actor: '值班人员' })); }
  resume(id: string) { this.store.dispatch(resumeBatch({ id, actor: '运维人员' })); }
  rollback(id: string) { this.store.dispatch(rollbackBatch({ id, actor: '发布负责人' })); }

  addRow() { this.receiptDraft.rows.push({ groupId: this.groups[0]?.id ?? 'g-edge', deviceNum: 0, result: 'installed' }); }
  removeRow(index: number) { this.receiptDraft.rows.splice(index, 1); }
  quickAdd() {
    const compatible = this.groups.filter((group) => group.compatible);
    this.receiptDraft.rows = compatible.map((group) => ({ groupId: group.id, deviceNum: this.nextDeviceNum(group.id), result: 'installed' }));
  }
  private nextDeviceNum(groupId: string): number {
    let max = -1;
    this.receipts$.subscribe((receipts: DeviceReceipt[]) => {
      for (const receipt of receipts) {
        if (receipt.groupId === groupId) {
          const num = Number(receipt.deviceId.split('#')[1]);
          if (!Number.isNaN(num) && num > max) max = num;
        }
      }
    }).unsubscribe();
    return max + 1;
  }

  submitReceipts() {
    const batch = this.batches.find((item) => item.id === this.receiptDraft.batchId);
    if (!batch) return;
    const items = this.receiptDraft.rows.map((row) => ({
      deviceId: `${row.groupId}#${row.deviceNum}`,
      groupId: row.groupId,
      result: row.result
    }));
    this.store.dispatch(submitReceipts({
      batchId: batch.id,
      items,
      actor: '值班员',
      expectedVersion: batch.version,
      simulateConcurrent: this.receiptDraft.simulateConcurrent,
      forceFailure: this.receiptDraft.forceFailure
    }));
  }

  changeVersion() {
    const firmware = this.versionDraft.firmware.trim();
    if (!firmware) return;
    this.store.dispatch(changeBatchVersion({ id: this.receiptDraft.batchId, firmware, actor: '发布负责人' }));
  }

  retryOutbox() { this.store.dispatch(retryOutbox({ actor: '值班员' })); }
  clearConflict() { this.store.dispatch(clearConflict()); }
  clearNotice() { this.store.dispatch(clearNotice()); }
  clearRejected() { this.store.dispatch(clearRejectedOutbox()); }

  groupNames(entry: PendingWrite): string {
    return [...new Set(entry.items.map((item) => item.groupId))].join('、');
  }
  receiptColor(status: string): string {
    if (status === 'installed') return 'primary';
    if (status === 'failed') return 'warn';
    if (status === 'invalidated') return '';
    return 'accent';
  }
}
