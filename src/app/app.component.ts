import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Store } from '@ngrx/store';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatTableModule } from '@angular/material/table';
import { TranslocoPipe } from '@jsverse/transloco';
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
} from './state/release.actions';
import { selectAudits, selectBatchViews, selectGroups, selectLastOutcome, selectReceiptLedger, selectRelease } from './state/release.selectors';
import type { InstallResult, ReceiptInput, ReleaseBatch, SubmitOutcome } from './state/release.models';

interface ReceiptDraft {
  groupId: string;
  deviceIds: string;
  firmware: string;
  result: InstallResult;
  actor: string;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, ScrollingModule, MatButtonModule, MatCardModule, MatChipsModule, MatFormFieldModule, MatInputModule, MatProgressBarModule, MatSelectModule, MatTableModule, TranslocoPipe],
  template: `
    <header class="hero">
      <div><span class="eyebrow">OTA LEDGER</span><h1>{{ 'title' | transloco }}</h1><p>设备分组 · 发布批次 · 回执三方记账，重复回执只算一次</p></div>
      <mat-chip-set><mat-chip highlighted>回执幂等</mat-chip><mat-chip>旧版本回执自动失效</mat-chip><mat-chip>乐观锁防双人覆盖</mat-chip></mat-chip-set>
    </header>

    <main>
      <section class="stats">
        <mat-card appearance="outlined"><span>批次数</span><strong>{{ (views$ | async)?.length ?? 0 }}</strong></mat-card>
        <mat-card appearance="outlined"><span>兼容分组</span><strong>{{ compatibleCount() }}</strong></mat-card>
        <mat-card appearance="outlined"><span>已暂停/回滚</span><strong>{{ pausedCount() }}</strong></mat-card>
        <mat-card appearance="outlined"><span>回执流水</span><strong>{{ (receipts$ | async)?.length ?? 0 }}</strong></mat-card>
        <mat-card appearance="outlined"><span>审计记录</span><strong>{{ (audits$ | async)?.length ?? 0 }}</strong></mat-card>
      </section>

      @if (outcome$ | async; as outcome) {
        <section class="outcome" [class]="'outcome outcome-' + outcome.kind">
          <div class="outcome-body">
            <b>{{ outcomeHead(outcome) }}</b>
            <p>{{ outcomeText(outcome) }}</p>
          </div>
          <div class="outcome-actions">
            @if (outcome.kind === 'conflict') {
              <button mat-flat-button color="primary" (click)="retryConflict(outcome)">按最新账期重试（去掉冲突设备）</button>
            }
            @if (outcome.kind === 'partial') {
              <button mat-flat-button color="primary" (click)="retryPartial(outcome)">只重试未完成分组</button>
            }
            <button mat-stroked-button (click)="dismiss()">知道了</button>
          </div>
        </section>
      }

      <section class="grid">
        <mat-card appearance="outlined">
          <mat-card-header><mat-card-title>{{ 'newBatch' | transloco }}</mat-card-title></mat-card-header>
          <mat-card-content class="form-grid">
            <mat-form-field><mat-label>批次名称</mat-label><input matInput [(ngModel)]="draft.name"></mat-form-field>
            <mat-form-field><mat-label>目标版本</mat-label><input matInput [(ngModel)]="draft.firmware"></mat-form-field>
            <mat-form-field><mat-label>回滚版本</mat-label><input matInput [(ngModel)]="draft.rollbackVersion"></mat-form-field>
            <mat-form-field>
              <mat-label>设备分组（可多选占位）</mat-label>
              <mat-select [(ngModel)]="draft.groupIds" multiple>
                <mat-option *ngFor="let group of groups$ | async" [value]="group.id" [disabled]="!group.compatible">{{ group.name }} · {{ group.region }} · {{ group.count }}台</mat-option>
              </mat-select>
            </mat-form-field>
            <mat-form-field><mat-label>灰度比例 %</mat-label><input matInput type="number" [(ngModel)]="draft.rolloutPercent"></mat-form-field>
            <mat-form-field><mat-label>失败阈值 %</mat-label><input matInput type="number" [(ngModel)]="draft.failureThreshold"></mat-form-field>
            <button mat-flat-button color="primary" (click)="create()">创建发布账批次</button>
          </mat-card-content>
        </mat-card>

        <mat-card appearance="outlined" class="batch-panel">
          <mat-card-header><mat-card-title>{{ 'batches' | transloco }}</mat-card-title></mat-card-header>
          <mat-card-content>
            <cdk-virtual-scroll-viewport autosize class="viewport">
              <article class="batch" *cdkVirtualFor="let view of views$ | async">
                <div class="row">
                  <div>
                    <b>{{ view.batch.name }}</b>
                    <small>目标 {{ view.batch.firmware }} → 回滚 {{ view.batch.rollbackVersion }} · 账期 rev{{ view.batch.revision }}</small>
                    <small>占用分组：<span *ngFor="let g of view.groups; let last = last">{{ g.name }}{{ last ? '' : '、' }}</span></small>
                  </div>
                  <mat-chip [color]="view.batch.status === 'paused' || view.batch.status === 'rolled_back' ? 'warn' : 'primary'" highlighted>{{ statusText(view.batch.status) }}</mat-chip>
                </div>

                <div class="group-chips">
                  <span class="group-chip" *ngFor="let g of view.stats.groupRollouts">
                    {{ groupName(g.groupId) }}：容量 {{ g.capacity }} / 占位 {{ g.occupied }} / 空闲 {{ g.free }}
                    <em *ngIf="g.capacity === 0">（分组不兼容或不在本批次）</em>
                  </span>
                </div>

                <mat-progress-bar mode="determinate" [value]="view.stats.progress"></mat-progress-bar>
                <div class="row">
                  <span>已装 {{ view.stats.installed }} · 失败 {{ view.stats.failed }} · 待执行 {{ view.stats.pending }} · 旧版保留现场 {{ view.stats.retained }} · 失败率 {{ view.stats.failureRate | number:'1.0-1' }}%</span>
                  <span>{{ view.stats.progress }}%</span>
                </div>

                <div class="retarget">
                  <mat-form-field appearance="outline" class="retarget-input">
                    <mat-label>换版发布（旧版未执行回执失效）</mat-label>
                    <input matInput [placeholder]="view.batch.firmware" [value]="retargetDrafts()[view.batch.id] || ''" (input)="setRetarget(view.batch.id, $event)">
                  </mat-form-field>
                  <button mat-stroked-button (click)="retarget(view.batch)">版本变更</button>
                </div>

                <mat-card appearance="outlined" class="receipt-form">
                  <div class="receipt-title">值班回执入账（当前应报版本 {{ view.batch.firmware }}）</div>
                  <div class="receipt-grid">
                    <mat-form-field appearance="outline">
                      <mat-label>值班员</mat-label>
                      <mat-select [value]="draftOf(view.batch.id).actor" (selectionChange)="patchDraft(view.batch.id, { actor: $event.value })">
                        <mat-option value="值班甲">值班甲</mat-option>
                        <mat-option value="值班乙">值班乙</mat-option>
                      </mat-select>
                    </mat-form-field>
                    <mat-form-field appearance="outline">
                      <mat-label>分组</mat-label>
                      <mat-select [value]="draftOf(view.batch.id).groupId" (selectionChange)="patchDraft(view.batch.id, { groupId: $event.value })">
                        <mat-option *ngFor="let g of view.groups" [value]="g.id">{{ g.name }}</mat-option>
                      </mat-select>
                    </mat-form-field>
                    <mat-form-field appearance="outline">
                      <mat-label>结果</mat-label>
                      <mat-select [value]="draftOf(view.batch.id).result" (selectionChange)="patchDraft(view.batch.id, { result: $event.value })">
                        <mat-option value="pending">已接收待执行</mat-option>
                        <mat-option value="installed">安装成功</mat-option>
                        <mat-option value="failed">安装失败</mat-option>
                      </mat-select>
                    </mat-form-field>
                    <mat-form-field appearance="outline">
                      <mat-label>回执版本（改成旧版可验证过期拒收）</mat-label>
                      <input matInput [value]="draftOf(view.batch.id).firmware" (input)="patchDraft(view.batch.id, { firmware: textOf($event) })">
                    </mat-form-field>
                    <mat-form-field appearance="outline" class="devices">
                      <mat-label>设备 ID（逗号或换行分隔，多台=一批回执）</mat-label>
                      <textarea matInput rows="2" [value]="draftOf(view.batch.id).deviceIds" (input)="patchDraft(view.batch.id, { deviceIds: textOf($event) })"></textarea>
                    </mat-form-field>
                  </div>
                  <div class="actions">
                    <button mat-flat-button color="primary" (click)="submitManual(view.batch)">提交回执</button>
                    <button mat-stroked-button (click)="concurrentDemo(view.batch)">双人同批并发演示</button>
                    <button mat-stroked-button (click)="partialFailureDemo(view.batch)">模拟分组写入失败</button>
                    <button mat-stroked-button (click)="injectLate(view.batch)">注入晚到回执</button>
                  </div>
                </mat-card>

                <div class="actions">
                  <button mat-stroked-button *ngIf="view.batch.status === 'draft'" (click)="approve(view.batch.id)">审批</button>
                  <button mat-stroked-button *ngIf="view.batch.status === 'approved'" (click)="resume(view.batch.id)">开始发布</button>
                  <button mat-stroked-button *ngIf="view.batch.status === 'running'" (click)="pause(view.batch.id)">暂停</button>
                  <button mat-stroked-button *ngIf="view.batch.status === 'paused'" (click)="resume(view.batch.id)">继续</button>
                  <button mat-flat-button color="warn" [disabled]="view.batch.status === 'completed' || view.batch.status === 'rolled_back'" (click)="rollback(view.batch.id)">紧急回滚</button>
                </div>
              </article>
            </cdk-virtual-scroll-viewport>
          </mat-card-content>
        </mat-card>
      </section>

      <mat-card appearance="outlined">
        <mat-card-header><mat-card-title>发布账流水（最近 60 行，stale/已替代行不计数不占位）</mat-card-title></mat-card-header>
        <mat-card-content>
          <table mat-table [dataSource]="(receipts$ | async) ?? []" class="ledger-table">
            <ng-container matColumnDef="at"><th mat-header-cell *matHeaderCellDef>时间</th><td mat-cell *matCellDef="let r">{{ r.at | date:'HH:mm:ss' }}</td></ng-container>
            <ng-container matColumnDef="receipt"><th mat-header-cell *matHeaderCellDef>回执号</th><td mat-cell *matCellDef="let r">{{ r.receiptId | slice:0:18 }}</td></ng-container>
            <ng-container matColumnDef="device"><th mat-header-cell *matHeaderCellDef>设备</th><td mat-cell *matCellDef="let r">{{ r.deviceId }}</td></ng-container>
            <ng-container matColumnDef="group"><th mat-header-cell *matHeaderCellDef>分组</th><td mat-cell *matCellDef="let r">{{ r.groupId }}</td></ng-container>
            <ng-container matColumnDef="firmware"><th mat-header-cell *matHeaderCellDef>版本</th><td mat-cell *matCellDef="let r">{{ r.firmware }}</td></ng-container>
            <ng-container matColumnDef="result"><th mat-header-cell *matHeaderCellDef>结果</th><td mat-cell *matCellDef="let r">{{ resultText(r.result) }}</td></ng-container>
            <ng-container matColumnDef="state">
              <th mat-header-cell *matHeaderCellDef>状态</th>
              <td mat-cell *matCellDef="let r">
                @if (r.stale) { <mat-chip color="warn" highlighted>旧版失效已释放占位</mat-chip> }
                @else if (r.supersededBy) { <mat-chip color="warn" highlighted>已被最终回执替代</mat-chip> }
                @else { <mat-chip highlighted>有效占位</mat-chip> }
              </td>
            </ng-container>
            <tr mat-header-row *matHeaderRowDef="ledgerColumns"></tr>
            <tr mat-row *matRowDef="let row; columns: ledgerColumns"></tr>
          </table>
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
    .hero h1 { margin:8px 0; font-size:clamp(28px,4vw,46px); letter-spacing:-.04em; } .hero p { margin:0; opacity:.85 } .eyebrow { letter-spacing:.2em; font-size:12px; opacity:.7 }
    main { padding:22px max(18px,5vw) 60px; display:grid; gap:20px; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:16px; } .stats span { display:block;color:#607d86 } .stats strong { font-size:30px }
    .grid { display:grid; grid-template-columns:minmax(320px,.8fr) minmax(440px,1.2fr); gap:20px; } .form-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; padding-top:16px }
    .viewport { height:620px; } .batch { min-height:132px; border-bottom:1px solid #dde7e8; padding:14px 4px; display:grid; gap:10px }
    .row { display:flex;justify-content:space-between;gap:12px;align-items:center } small { display:block;color:#71858c } .actions { display:flex;gap:8px;flex-wrap:wrap }
    .group-chips { display:flex;gap:8px;flex-wrap:wrap } .group-chip { font-size:12px;background:#e7f0ef;border:1px solid #cfe0de;border-radius:999px;padding:3px 10px;color:#37525a } .group-chip em { color:#b0691a;font-style:normal }
    .retarget { display:flex;gap:10px;align-items:flex-start } .retarget-input { flex:1 } .retarget .mat-mdc-form-field-bottom-align { display:none }
    .receipt-form { padding:10px 12px; background:#f7faf9 } .receipt-title { font-size:13px;color:#45636b;margin-bottom:6px } .receipt-grid { display:grid;grid-template-columns:1fr 1fr;gap:0 10px } .receipt-grid .devices { grid-column:1/-1 }
    .outcome { display:flex;justify-content:space-between;gap:16px;align-items:center;border-radius:10px;padding:14px 18px;border:1px solid }
    .outcome b { display:block;margin-bottom:2px } .outcome p { margin:0;font-size:13px } .outcome-actions { display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end }
    .outcome-committed { background:#eaf7ee;border-color:#9bd3ac;color:#1d5c33 } .outcome-partial { background:#fff6e5;border-color:#e9c47a;color:#7a5410 }
    .outcome-conflict { background:#fdeceb;border-color:#e3a19c;color:#8c2f28 } .outcome-rejected { background:#fdeceb;border-color:#e3a19c;color:#8c2f28 }
    .ledger-table { width:100% }
    .audit-list { max-height:320px; overflow:auto } .audit { display:grid;grid-template-columns:120px 110px 1fr;border-bottom:1px solid #e5ecee;padding:10px 4px } .audit p { margin:0 }
    @media(max-width:900px){ .hero{align-items:flex-start;flex-direction:column}.grid{grid-template-columns:1fr}.form-grid{grid-template-columns:1fr}.receipt-grid{grid-template-columns:1fr}.audit{grid-template-columns:1fr}.viewport{height:520px} }
  `]
})
export class AppComponent implements OnInit, OnDestroy {
  readonly store = inject(Store);
  readonly groups$ = this.store.select(selectGroups);
  readonly views$ = this.store.select(selectBatchViews);
  readonly audits$ = this.store.select(selectAudits);
  readonly receipts$ = this.store.select(selectReceiptLedger);
  readonly outcome$ = this.store.select(selectLastOutcome);
  readonly ledgerColumns = ['at', 'receipt', 'device', 'group', 'firmware', 'result', 'state'];

  private timer?: number;
  /** 最近一次手工/演示提交的原始回执，供部分失败重试 */
  private lastRequests = new Map<string, ReceiptInput[]>();

  draft = { name: '', firmware: '3.0.0', rollbackVersion: '2.9.2', groupIds: ['g-edge'], rolloutPercent: 10, failureThreshold: 30 };
  private drafts = signal<Record<string, ReceiptDraft>>({});
  readonly retargetDrafts = signal<Record<string, string>>({});

  ngOnInit() {
    // 模拟离线设备晚到回执：暂停/回滚的批次不会被它推进
    this.timer = window.setInterval(() => this.store.dispatch(simulateLateReceipt()), 2600);
    this.store.select(selectRelease).subscribe((state) => {
      const { lastOutcome: _ignored, ...persisted } = state;
      localStorage.setItem('firmware-release-ledger-v2', JSON.stringify(persisted));
    });
  }
  ngOnDestroy() { if (this.timer) window.clearInterval(this.timer); }

  pausedCount() {
    let count = 0;
    this.views$.subscribe((items) => count = items.filter((item) => item.batch.status === 'paused' || item.batch.status === 'rolled_back').length);
    return count;
  }

  compatibleCount() {
    let count = 0;
    this.groups$.subscribe((groups) => count = groups.filter((g) => g.compatible).length);
    return count;
  }

  dismiss() { this.store.dispatch(clearOutcome()); }

  groupName(id: string): string {
    let name = id;
    this.groups$.subscribe((groups) => { name = groups.find((g) => g.id === id)?.name ?? id; });
    return name;
  }

  statusText(status: string): string {
    return ({ draft: '草稿', approved: '已审批', running: '发布中', paused: '已暂停', completed: '已完成', rolled_back: '已回滚' })[status] ?? status;
  }
  resultText(result: string): string {
    return ({ pending: '待执行', installed: '安装成功', failed: '安装失败' })[result] ?? result;
  }

  textOf(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  draftOf(batchId: string): ReceiptDraft {
    return this.drafts()[batchId] ?? { groupId: '', deviceIds: '', firmware: '', result: 'installed', actor: '值班甲' };
  }
  patchDraft(batchId: string, patch: Partial<ReceiptDraft>) {
    this.drafts.update((map) => ({ ...map, [batchId]: { ...this.draftOf(batchId), ...patch } }));
  }
  setRetarget(batchId: string, event: Event) {
    this.retargetDrafts.update((map) => ({ ...map, [batchId]: this.textOf(event) }));
  }

  create() {
    if (!this.draft.name || !this.draft.firmware || this.draft.groupIds.length === 0) return;
    this.store.dispatch(createBatch({ ...this.draft }));
    this.draft = { ...this.draft, name: '' };
  }
  approve(id: string) { this.store.dispatch(approveBatch({ id, actor: '发布负责人' })); }
  pause(id: string) { this.store.dispatch(pauseBatch({ id, actor: '值班人员' })); }
  resume(id: string) { this.store.dispatch(resumeBatch({ id, actor: '运维人员' })); }
  rollback(id: string) { this.store.dispatch(rollbackBatch({ id, actor: '发布负责人' })); }
  retarget(batch: ReleaseBatch) {
    const firmware = (this.retargetDrafts()[batch.id] ?? '').trim();
    if (!firmware || firmware === batch.firmware) return;
    this.store.dispatch(retargetBatchVersion({ id: batch.id, firmware, actor: '发布负责人' }));
    this.patchDraft(batch.id, { firmware });
    this.retargetDrafts.update((map) => ({ ...map, [batch.id]: '' }));
  }

  private buildInputs(batch: ReleaseBatch, groupId: string, devices: string[], result: InstallResult, firmware: string): ReceiptInput[] {
    return devices
      .map((deviceId) => deviceId.trim())
      .filter(Boolean)
      .map((deviceId) => ({ receiptId: `rcp-${crypto.randomUUID()}`, groupId, deviceId, firmware: firmware || batch.firmware, result }));
  }

  submitManual(batch: ReleaseBatch) {
    const draft = this.draftOf(batch.id);
    const groupId = draft.groupId || batch.groupIds[0];
    const devices = draft.deviceIds.split(/[,，\n]/);
    const inputs = this.buildInputs(batch, groupId, devices, draft.result, draft.firmware);
    if (inputs.length === 0) return;
    this.lastRequests.set(batch.id, inputs);
    this.store.dispatch(submitReceipts({ batchId: batch.id, actor: draft.actor, inputs, expectedRevision: batch.revision }));
  }

  /** 两个值班员基于同一 revision 各自提交，其中一台设备相同：后到者必然收到冲突 */
  concurrentDemo(batch: ReleaseBatch) {
    const groupId = batch.groupIds[0];
    const stamp = crypto.randomUUID().slice(0, 8);
    const shared = `race-${stamp}-shared`;
    const inputsA: ReceiptInput[] = [
      { receiptId: `A-${stamp}-1`, groupId, deviceId: `race-${stamp}-a`, firmware: batch.firmware, result: 'installed' },
      { receiptId: `A-${stamp}-2`, groupId, deviceId: shared, firmware: batch.firmware, result: 'installed' },
    ];
    const inputsB: ReceiptInput[] = [
      { receiptId: `B-${stamp}-1`, groupId, deviceId: shared, firmware: batch.firmware, result: 'installed' },
      { receiptId: `B-${stamp}-2`, groupId, deviceId: `race-${stamp}-b`, firmware: batch.firmware, result: 'installed' },
    ];
    this.lastRequests.set(batch.id, [...inputsA, ...inputsB]);
    this.store.dispatch(submitReceipts({ batchId: batch.id, actor: '值班甲', inputs: inputsA, expectedRevision: batch.revision }));
    this.store.dispatch(submitReceipts({ batchId: batch.id, actor: '值班乙', inputs: inputsB, expectedRevision: batch.revision }));
  }

  /** 第一个分组成功落账，第二个分组写入失败；重试时整批重发，成功组靠回执号幂等不重复计数 */
  partialFailureDemo(batch: ReleaseBatch) {
    if (batch.groupIds.length < 2) return;
    const stamp = crypto.randomUUID().slice(0, 8);
    const [g1, g2] = batch.groupIds;
    const inputs: ReceiptInput[] = [
      { receiptId: `PF-${stamp}-1`, groupId: g1, deviceId: `pf-${stamp}-g1`, firmware: batch.firmware, result: 'installed' },
      { receiptId: `PF-${stamp}-2`, groupId: g2, deviceId: `pf-${stamp}-g2`, firmware: batch.firmware, result: 'installed' },
    ];
    this.lastRequests.set(batch.id, inputs);
    this.store.dispatch(submitReceipts({ batchId: batch.id, actor: '值班甲', inputs, failGroups: [g2], expectedRevision: batch.revision }));
  }

  /** 晚到回执：即使批次已暂停/回滚也照发，账本负责“登记现场但不推进 / 回滚拒收” */
  injectLate(batch: ReleaseBatch) {
    const groupId = batch.groupIds[0];
    const deviceId = `late-${crypto.randomUUID().slice(0, 8)}`;
    const inputs = this.buildInputs(batch, groupId, [deviceId], 'installed', batch.firmware);
    this.store.dispatch(submitReceipts({ batchId: batch.id, actor: '离线设备', inputs, expectedRevision: batch.revision }));
  }

  retryConflict(outcome: Extract<SubmitOutcome, { kind: 'conflict' }>) {
    const conflict = new Set(outcome.conflictDevices);
    const inputs = outcome.retriable.filter((input) => !conflict.has(input.deviceId));
    if (inputs.length === 0) { this.store.dispatch(clearOutcome()); return; }
    this.store.dispatch(submitReceipts({ batchId: outcome.batchId, actor: '值班乙', inputs, expectedRevision: outcome.actualRevision }));
  }

  retryPartial(outcome: Extract<SubmitOutcome, { kind: 'partial' }>) {
    const requested = this.lastRequests.get(outcome.batchId) ?? [];
    // 原样重发：已成功分组的同号回执命中幂等；只有失败分组真正落账
    this.store.dispatch(submitReceipts({ batchId: outcome.batchId, actor: '值班甲', inputs: requested }));
  }

  outcomeHead(outcome: SubmitOutcome): string {
    switch (outcome.kind) {
      case 'committed': return '回执已入账';
      case 'partial': return '部分分组写入失败，已完成分组保留';
      case 'conflict': return '提交冲突：账期已被另一位值班员推进';
      case 'rejected':
        return outcome.reason === 'rolled_back' ? '批次已回滚，回执拒收' : outcome.reason === 'draft' ? '批次尚未审批，回执拒收' : '批次不存在，回执拒收';
    }
  }

  outcomeText(outcome: SubmitOutcome): string {
    if (outcome.kind === 'committed' || outcome.kind === 'partial') {
      const parts = [`新登记 ${outcome.applied} 台`];
      if (outcome.duplicates.length) parts.push(`重复回执 ${outcome.duplicates.length} 条只计一次`);
      if (outcome.overflow.length) parts.push(`超出占位 ${outcome.overflow.length} 台被拒`);
      if (outcome.staleRejected.length) parts.push(`旧版本回执 ${outcome.staleRejected.length} 台失效`);
      if (outcome.wrongGroup.length) parts.push(`非本批次分组 ${outcome.wrongGroup.length} 台`);
      if (outcome.kind === 'partial') parts.push(`失败分组：${outcome.failedGroups.join('、')}（成功分组 ${outcome.committedGroups.join('、')} 已保留）`);
      parts.push(`最新状态：${this.statusText(outcome.status)}`);
      return parts.join('；');
    }
    if (outcome.kind === 'conflict') {
      return `你的账期 rev${outcome.expectedRevision} 已过期，最新 rev${outcome.actualRevision}（版本 ${outcome.currentFirmware}，状态 ${this.statusText(outcome.status)}）；冲突设备：${outcome.conflictDevices.join('、') || '无'}。重试将携带最新 revision 并跳过冲突设备。`;
    }
    return '该回执未改动发布账，重试也不会覆盖回滚现场。';
  }
}
