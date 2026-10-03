import {
  $, component$, useComputed$, useSignal, useStore, useVisibleTask$
} from '@builder.io/qwik';
import { Checkbox, Modal, Tabs } from '@qwik-ui/headless';
import type {
  AppliedItem, ComparisonPackage, DeskState, Dispute, DisputeField, FieldState, RubbingRecord
} from './types';
import { DISPUTE_FIELDS, DISPUTE_LABELS } from './types';
import {
  importPackage, normalizePackage, renameLocalNo, resolveDispute, uid
} from './utils/reconcile';
import { seedState } from './data/seed';

const STORAGE_KEY = 'sologsb-1020-rubbing-desk-v2';

const FIELD_ACCENT: Record<DisputeField, string> = { paper: '#8a6a3f', rubber: '#3f7585', seals: '#8a4f63' };

const byStable = (state: DeskState, stableId: string) =>
  state.records.find((record) => record.stableId === stableId);

const fieldBadge = (fieldState: FieldState) =>
  fieldState.confirmed ? '<已确认>' : fieldState.variants.length > 1 ? `并列${fieldState.variants.length}说` : fieldState.variants[0] ? '单值' : '缺录';

interface ImportReport {
  packageId: string;
  packageVersion: number;
  results: AppliedItem[];
  skipped: number;
  interrupted: boolean;
  processedCount: number;
  total: number;
}

export default component$(() => {
  const state = useStore<DeskState>(seedState());
  const history = useSignal<string[]>([]);
  const future = useSignal<string[]>([]);

  const query = useSignal('');
  const fieldFilter = useSignal<'all' | DisputeField>('all');
  const visibleCount = useSignal(80);
  const selectedDisputeIds = useSignal<string[]>([]);

  const importOpen = useSignal(false);
  const importRaw = useSignal('');
  const importName = useSignal('');
  const parsedPkg = useSignal<ComparisonPackage | null>(null);
  const parseError = useSignal('');
  const simulateFail = useSignal(false);
  const failAfter = useSignal(3);
  const importReport = useSignal<ImportReport | null>(null);

  const resolveOpen = useSignal(false);
  const activeDisputeId = useSignal('');
  const chosenValue = useSignal('');

  const renameOpen = useSignal(false);
  const renameTargetId = useSignal('');
  const renameValue = useSignal('');

  const toast = useSignal('');
  const panelTab = useSignal(0);

  // —— 撤销 / 重做 ——
  const snapshot = $(() => JSON.stringify({
    revision: state.revision,
    records: state.records,
    disputes: state.disputes,
    importedItems: state.importedItems,
    importBatches: state.importBatches,
    audit: state.audit
  }));

  const capture = $(async () => {
    history.value = [...history.value.slice(-49), await snapshot()];
    future.value = [];
  });

  const restore = $(async (raw: string) => {
    const next = JSON.parse(raw) as Partial<DeskState>;
    state.revision = next.revision ?? state.revision;
    state.records = next.records ?? state.records;
    state.disputes = next.disputes ?? state.disputes;
    state.importedItems = next.importedItems ?? state.importedItems;
    state.importBatches = next.importBatches ?? state.importBatches;
    state.audit = next.audit ?? state.audit;
  });

  const notify = $((message: string) => {
    toast.value = message;
    window.setTimeout(() => { if (toast.value === message) toast.value = ''; }, 3200);
  });

  const commit = $((action: string, detail: string, stableIds: string[] = []) => {
    state.revision += 1;
    state.audit = [
      { id: uid('aud'), at: new Date().toISOString(), action, detail, stableIds },
      ...state.audit
    ].slice(0, 400);
  });

  const undo = $(async () => {
    const raw = history.value.at(-1);
    if (!raw) return;
    future.value = [...future.value, await snapshot()];
    history.value = history.value.slice(0, -1);
    await restore(raw);
  });

  const redo = $(async () => {
    const raw = future.value.at(-1);
    if (!raw) return;
    history.value = [...history.value, await snapshot()];
    future.value = future.value.slice(0, -1);
    await restore(raw);
  });

  // —— 派生视图 ——
  const pendingDisputes = useComputed$(() =>
    state.disputes.filter((dispute) => dispute.status === 'pending'));

  const visibleDisputes = useComputed$(() => pendingDisputes.value
    .filter((dispute) => fieldFilter.value === 'all' || dispute.field === fieldFilter.value)
    .sort((a, b) => a.stableId.localeCompare(b.stableId) || a.field.localeCompare(b.field)));

  const filteredRecords = useComputed$(() => {
    const term = query.value.trim().toLowerCase();
    return state.records
      .filter((record) => !term || [
        record.stableId, record.localNo, record.title, record.batch,
        record.originalStone, ...record.aliases
      ].join(' ').toLowerCase().includes(term))
      .sort((a, b) => a.stableId.localeCompare(b.stableId))
      .slice(0, visibleCount.value);
  });

  const confirmedCount = useComputed$(() =>
    state.records.reduce((sum, record) =>
      sum + DISPUTE_FIELDS.filter((field) => record[field].confirmed).length, 0));

  const pendingBatch = useComputed$(() =>
    state.importBatches.find((batch) => batch.finishedAt === null) ?? null);

  // —— 待裁项处理（确认前并列保留，确认后写回受保护结果） ——
  const openResolve = $((dispute: Dispute) => {
    activeDisputeId.value = dispute.id;
    chosenValue.value = dispute.variants[0] ?? '';
    resolveOpen.value = true;
  });

  const applyResolve = $(async () => {
    const dispute = state.disputes.find((item) => item.id === activeDisputeId.value);
    const record = dispute ? byStable(state, dispute.stableId) : undefined;
    if (!dispute || !record) return;
    const value = chosenValue.value.trim();
    if (!value) { await notify('请填写或选择确认值'); return; }
    await capture();
    const updated = resolveDispute(record, dispute.field, value, new Date().toISOString());
    state.records = state.records.map((entry) => (entry.stableId === record.stableId ? updated : entry));
    state.disputes = state.disputes.map((item) => item.id === dispute.id ? {
      ...item, status: 'resolved' as const, resolvedAt: new Date().toISOString(), resolution: value
    } : item);
    await commit(
      `裁定${DISPUTE_LABELS[dispute.field]}分歧`,
      `《${record.title}》${DISPUTE_LABELS[dispute.field]}确认为“${value}”，并列候选 ${dispute.variants.length} 项仍留档`,
      [record.stableId]
    );
    resolveOpen.value = false;
    selectedDisputeIds.value = selectedDisputeIds.value.filter((id) => id !== dispute.id);
    await notify(`已确认 ${DISPUTE_LABELS[dispute.field]}，此后回传不再覆盖该结果`);
  });

  const batchResolve = $(async () => {
    const ids = selectedDisputeIds.value;
    if (!ids.length) return;
    await capture();
    let done = 0;
    const touched = new Set<string>();
    ids.forEach((id) => {
      const dispute = state.disputes.find((item) => item.id === id);
      if (!dispute || dispute.status !== 'pending') return;
      const record = byStable(state, dispute.stableId);
      if (!record) return;
      // 批量操作取该字段第一个并列候选作为确认值，逐条仍可在审计中追溯
      const value = dispute.variants[0];
      if (!value) return;
      const updated = resolveDispute(record, dispute.field, value, new Date().toISOString());
      state.records = state.records.map((entry) => (entry.stableId === record.stableId ? updated : entry));
      state.disputes = state.disputes.map((item) => item.id === id ? {
        ...item, status: 'resolved' as const, resolvedAt: new Date().toISOString(), resolution: value
      } : item);
      done += 1;
      touched.add(record.stableId);
    });
    await commit('批量裁定待裁项', `按首列候选确认 ${done} 项纸张/拓工/钤印分歧`, [...touched]);
    selectedDisputeIds.value = [];
    await notify(`已批量裁定 ${done} 项`);
  });

  // —— 本机改编号 ——
  const openRename = $((record: RubbingRecord) => {
    renameTargetId.value = record.stableId;
    renameValue.value = record.localNo;
    renameOpen.value = true;
  });

  const applyRename = $(async () => {
    const record = byStable(state, renameTargetId.value);
    if (!record) return;
    const value = renameValue.value.trim();
    if (!value || value === record.localNo) { renameOpen.value = false; return; }
    await capture();
    const updated = renameLocalNo(record, value, new Date().toISOString());
    state.records = state.records.map((entry) => (entry.stableId === record.stableId ? updated : entry));
    await commit('修改本机编号', `《${record.title}》本机编号 ${record.localNo} → ${value}，稳定编号 ${record.stableId} 不变，旧编号并入别名`, [record.stableId]);
    renameOpen.value = false;
    await notify('本机编号已改；回传仍按稳定编号挂回，不会错配');
  });

  // —— 导入解析 ——
  const parsePkg = $(() => {
    parseError.value = '';
    parsedPkg.value = null;
    const raw = importRaw.value.trim();
    if (!raw) return;
    try {
      const pkg = normalizePackage(JSON.parse(raw));
      if (!pkg.items.length) { parseError.value = '包内没有可导入的拓片条目（缺少稳定编号的条目会被忽略）'; return; }
      parsedPkg.value = pkg;
    } catch {
      parseError.value = '无法解析 JSON，请检查比对包文件格式';
    }
  });

  const readFile = $(async (_event: Event, element: HTMLInputElement) => {
    const file = element.files?.[0];
    if (!file) return;
    importRaw.value = await file.text();
    importName.value = file.name;
    await parsePkg();
  });

  // 真正执行导入；续传时 opts 传入此前已处理的 key，不重复建档
  const runImport = $(async (resumeKeys?: string[]) => {
    const pkg = parsedPkg.value;
    if (!pkg) return;
    await capture();
    const outcome = importPackage(
      {
        records: state.records,
        disputes: state.disputes,
        importedItems: state.importedItems,
        importBatches: state.importBatches
      },
      pkg,
      {
        processedKeys: resumeKeys,
        // 勾选“模拟写入中断”且是该包首次导入时，处理到第 N 条中断以保留进度
        failAfter: simulateFail.value && !resumeKeys ? failAfter.value : undefined
      }
    );
    state.records = outcome.records;
    state.disputes = outcome.disputes;
    state.importedItems = outcome.importedItems;
    state.importBatches = [
      outcome.batch,
      ...state.importBatches.filter((batch) => batch.packageId !== pkg.packageId)
    ];

    const created = outcome.results.filter((r) => r.created).length;
    const matched = outcome.results.length - created;
    const newDisputes = outcome.results.flatMap((r) => r.newDisputes);
    const blocked = outcome.results.filter((r) => r.blockedFields.length);
    const fpMismatch = outcome.results.filter((r) => r.fingerprintMismatch);

    const details: string[] = [];
    details.push(`挂回已有记录 ${matched} 件、新建档 ${created} 件`);
    if (outcome.skipped) details.push(`重试跳过已处理条目 ${outcome.skipped} 条（未重复建档）`);
    if (newDisputes.length) details.push(`新增待裁项 ${newDisputes.length} 项，纸张/拓工/钤印分歧已并列保留`);
    if (blocked.length) details.push(`${blocked.length} 件的已确认字段受保护，未被覆盖（${blocked.flatMap((r) => r.blockedFields.map((f) => DISPUTE_LABELS[f])).join('、')}）`);
    if (fpMismatch.length) details.push(`扫描指纹不一致 ${fpMismatch.length} 件，仅提示不改写`);
    if (pkg.packageVersion < 2) details.push(`旧版包 v${pkg.packageVersion} 已按兼容规则迁移导入`);

    await commit(
      outcome.interrupted ? '回传导入（中断，进度已保留）' : '回传导入比对包',
      `${pkg.packageId}：${details.join('；')}`,
      outcome.results.map((r) => r.stableId)
    );

    importReport.value = {
      packageId: pkg.packageId,
      packageVersion: pkg.packageVersion,
      results: outcome.results,
      skipped: outcome.skipped,
      interrupted: outcome.interrupted,
      processedCount: outcome.processedCount,
      total: outcome.batch.totalItems
    };

    if (outcome.interrupted) {
      await notify(`写入中断：已保留前 ${outcome.results.length} 条进度，可再次选择同一包“续传”`);
    } else {
      await notify(`导入完成：挂回 ${matched} 件、新建 ${created} 件，跳过 ${outcome.skipped} 条`);
    }
  });

  const resumeImport = $(async () => {
    const batch = state.importBatches.find((b) => b.packageId === parsedPkg.value?.packageId);
    await runImport(batch?.processedKeys ?? []);
  });

  const closeImport = $(() => {
    // 中断时保留已解析包，方便直接续传；完成后清空
    const interruptedHere = importReport.value?.interrupted;
    importOpen.value = false;
    if (!interruptedHere) {
      importRaw.value = '';
      importName.value = '';
      parsedPkg.value = null;
      importReport.value = null;
      parseError.value = '';
    }
  });

  // —— 导出回执包：待裁项处理完才允许更新导出包 ——
  const exportReceipt = $(async () => {
    if (pendingDisputes.value.length) {
      await notify(`仍有 ${pendingDisputes.value.length} 项待裁，请处理完再更新导出包`);
      panelTab.value = 0;
      return;
    }
    const payload = {
      kind: 'rubbing-version-receipt',
      receiptVersion: 2,
      exportedAt: new Date().toISOString(),
      stateRevision: state.revision,
      pendingDisputeCount: 0,
      records: state.records.map((record) => ({
        stableId: record.stableId,
        localNo: record.localNo,
        title: record.title,
        batch: record.batch,
        originalStone: record.originalStone,
        scanFingerprint: record.scanFingerprint,
        paper: record.paper,
        rubber: record.rubber,
        seals: record.seals,
        notes: record.notes,
        updatedAt: record.updatedAt
      })),
      resolvedDisputes: state.disputes
        .filter((dispute) => dispute.status === 'resolved')
        .map((dispute) => ({
          id: dispute.id, stableId: dispute.stableId, field: dispute.field,
          resolution: dispute.resolution, resolvedAt: dispute.resolvedAt
        })),
      audit: state.audit
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `碑帖拓片版本回执-r${state.revision}-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    await commit('导出回执包', `按 r${state.revision} 导出版本回执，含 ${state.records.length} 件记录与全部裁定结果`, state.records.map((r) => r.stableId));
    await notify('回执包已导出');
  });

  // —— 本地离线保存（写入即持久化，天然支持中断续传） ——
  useVisibleTask$(async () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) await restore(raw);
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
    state.hydrated = true;
  });

  useVisibleTask$(async ({ track }) => {
    track(() => state.revision);
    if (!state.hydrated) return;
    const payload = await snapshot();
    try {
      localStorage.setItem(STORAGE_KEY, payload);
    } catch {
      await notify('本地存储空间不足，进度可能未完全保存');
    }
  });

  // —— 键盘密集审核 ——
  useVisibleTask$(({ cleanup }) => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const editing = /INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        event.shiftKey ? void redo() : void undo();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); void redo(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'i') { event.preventDefault(); importOpen.value = true; return; }
      if (editing) return;
      const key = event.key.toLowerCase();
      if (key === 'j' || key === 'k') {
        event.preventDefault();
        const list = visibleDisputes.value;
        const index = list.findIndex((dispute) => dispute.id === activeDisputeId.value);
        const next = list[Math.max(0, Math.min(list.length - 1, index + (key === 'j' ? 1 : -1)))];
        if (next) {
          activeDisputeId.value = next.id;
          document.querySelector(`[data-dispute-id="${next.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
      if (key === 'x' && activeDisputeId.value) {
        const dispute = state.disputes.find((item) => item.id === activeDisputeId.value);
        if (dispute && dispute.status === 'pending') void openResolve(dispute);
      }
    };
    window.addEventListener('keydown', handler);
    cleanup(() => window.removeEventListener('keydown', handler));
  });

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-seal">拓</div>
          <div><h1>碑帖拓片版本比对台</h1><p>RUBBING VERSION RECONCILIATION DESK</p></div>
        </div>
        <div class="top-stat"><span class="online-dot" />{state.hydrated ? `离线保存 · r${state.revision}` : '正在恢复本地工作区'}</div>
        <div class="top-actions">
          <button class="icon-button" disabled={!history.value.length} onClick$={undo}>撤销</button>
          <button class="icon-button" disabled={!future.value.length} onClick$={redo}>重做</button>
          <button class="button ghost" onClick$={() => { importReport.value = null; importOpen.value = true; }}>回传导入比对包</button>
          <button class={`button ${pendingDisputes.value.length ? 'light' : 'primary'}`} onClick$={exportReceipt}>
            {pendingDisputes.value.length ? `导出被待裁项阻塞（${pendingDisputes.value.length}）` : '更新导出回执包'}
          </button>
        </div>
      </header>

      <div class="overview">
        <div>
          <span class="eyebrow">STELA RUBBING · VERSION LEDGER</span>
          <h2>外场回传 · 版本对账</h2>
          <p>以拓片号稳定挂回原记录；纸张、拓工、钤印有分歧时并列保留，确认后受保护；写入中断可续传，重试不重复建档。</p>
        </div>
        <div class="metrics">
          <div><strong>{state.records.length}</strong><span>在台账拓片</span></div>
          <div class={pendingDisputes.value.length ? 'danger' : ''}><strong>{pendingDisputes.value.length}</strong><span>待裁项</span></div>
          <div><strong>{confirmedCount.value}</strong><span>已确认字段</span></div>
          <div><strong>{state.importBatches.length}</strong><span>历史导入包</span></div>
        </div>
      </div>

      {pendingBatch.value && (
        <div class="resume-banner">
          <span>检测到未完成导入：{pendingBatch.value.packageId}（已处理 {pendingBatch.value.processedKeys.length}/{pendingBatch.value.totalItems} 条，进度已保留）。</span>
          <button class="button small" onClick$={() => { importOpen.value = true; }}>选择同一包续传</button>
        </div>
      )}

      <main class="desk-grid">
        {/* 待裁项队列 */}
        <section class="panel dispute-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">01 / PENDING DECISIONS</span><h3>待裁项队列</h3></div>
            <span class="shortcut-hint">J / K 移动 · X 裁定</span>
          </div>
          <div class="toolbar-row">
            <select class="input" value={fieldFilter.value} onChange$={(event) => { fieldFilter.value = (event.target as HTMLSelectElement).value as typeof fieldFilter.value; }}>
              <option value="all">纸张 / 拓工 / 钤印</option>
              <option value="paper">纸张</option>
              <option value="rubber">拓工</option>
              <option value="seals">钤印</option>
            </select>
            <button class="button small" disabled={!selectedDisputeIds.value.length} onClick$={batchResolve}>批量取首项确认</button>
          </div>
          <div class="dispute-list">
            {visibleDisputes.value.map((dispute) => {
              const record = byStable(state, dispute.stableId);
              const isActive = activeDisputeId.value === dispute.id;
              return (
                <article
                  key={dispute.id}
                  data-dispute-id={dispute.id}
                  class={`dispute-card ${isActive ? 'active' : ''}`}
                  onClick$={() => { activeDisputeId.value = dispute.id; }}
                  tabIndex={0}
                >
                  <div class="dispute-top">
                    <Checkbox.Root
                      class="qwik-check"
                      aria-label="选择待裁项"
                      initialValue={selectedDisputeIds.value.includes(dispute.id)}
                      onClick$={(event: Event) => {
                        event.stopPropagation();
                        selectedDisputeIds.value = selectedDisputeIds.value.includes(dispute.id)
                          ? selectedDisputeIds.value.filter((id) => id !== dispute.id)
                          : [...selectedDisputeIds.value, dispute.id];
                      }}
                    ><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Root>
                    <span class="dispute-field" style={`background:${FIELD_ACCENT[dispute.field]}`}>{DISPUTE_LABELS[dispute.field]}</span>
                    <code class="stable-id">{dispute.stableId}</code>
                    <button class="button small primary decide-btn" onClick$={() => openResolve(dispute)}>裁定</button>
                  </div>
                  <strong class="dispute-title">{record?.title ?? dispute.stableId}</strong>
                  <div class="variant-row">
                    {dispute.variants.map((value) => (
                      <span key={value} class="variant-pill">{value}</span>
                    ))}
                  </div>
                  <p class="dispute-note">并列保留中，确认前任一候选都不会被覆盖</p>
                </article>
              );
            })}
            {!visibleDisputes.value.length && (
              <div class="empty-state">没有待裁项。<br />纸张 / 拓工 / 钤印出现新分歧时会自动进入此队列。</div>
            )}
          </div>
        </section>

        {/* 拓片台账 */}
        <section class="panel ledger-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">02 / RUBBING LEDGER</span><h3>拓片台账（稳定编号挂接）</h3></div>
            <span class="shortcut-hint">分页渲染 · 当前 {filteredRecords.value.length} 件</span>
          </div>
          <div class="toolbar-row">
            <input
              class="input search"
              placeholder="搜索拓片号 / 本机编号 / 别名 / 名称 / 批次"
              value={query.value}
              onInput$={(event) => { query.value = (event.target as HTMLInputElement).value; visibleCount.value = 80; }}
            />
          </div>
          <div class="ledger-list">
            {filteredRecords.value.map((record) => {
              const pending = state.disputes.some((d) => d.stableId === record.stableId && d.status === 'pending');
              return (
                <article class="ledger-card" key={record.stableId}>
                  <div class="ledger-head">
                    <code class="stable-id strong">{record.stableId}</code>
                    <span class={`lock-dot ${pending ? 'pending' : 'allclear'}`} title={pending ? '存在待裁项' : '字段均已确认或单值'} />
                    <strong class="ledger-title">{record.title}</strong>
                    <button class="rename-btn" onClick$={() => openRename(record)} title="修改本机编号（不影响稳定编号）">改编号</button>
                  </div>
                  <div class="ledger-meta">
                    <span>本机编号 <b>{record.localNo}</b></span>
                    {record.aliases.length > 0 && <span class="aliases">曾用/外场编号 {record.aliases.map((a) => <code>{a}</code>)}</span>}
                  </div>
                  <div class="ledger-meta"><span>摹刻批次 {record.batch}</span><span>原石 {record.originalStone}</span></div>
                  <div class="fingerprint-row">
                    <span>指纹 {record.scanFingerprint || '—'}</span>
                    <span class="last-import">{record.lastImportItemNo ? `最近挂接条目 ${record.lastImportItemNo}` : '尚未经回传挂接'}</span>
                  </div>
                  <div class="field-grid">
                    {DISPUTE_FIELDS.map((f) => {
                      const fs = record[f];
                      return (
                        <div class={`field-cell ${fs.confirmed ? 'confirmed' : fs.variants.length > 1 ? 'multi' : ''}`} key={f}>
                          <small>{DISPUTE_LABELS[f]} · {fieldBadge(fs)}</small>
                          {fs.variants.map((v) => (
                            <span key={v} class={fs.confirmed && fs.chosen === v ? 'chosen' : fs.confirmed ? 'dropped' : ''}>{v}</span>
                          ))}
                          {!fs.variants.length && <em>缺录</em>}
                        </div>
                      );
                    })}
                  </div>
                </article>
              );
            })}
          </div>
          {filteredRecords.value.length >= visibleCount.value && (
            <button class="load-more" onClick$={() => visibleCount.value += 80}>加载下 80 件</button>
          )}
        </section>

        {/* 右侧：审计 / 导入履历 / 帮助 */}
        <section class="panel side-panel">
          <Tabs.Root bind:selectedIndex={panelTab} class="review-tabs">
            <Tabs.List class="tab-list">
              <Tabs.Tab>审计轨迹</Tabs.Tab><Tabs.Tab>导入履历</Tabs.Tab><Tabs.Tab>规则与键位</Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel class="tab-panel">
              <div class="audit-list">
                {state.audit.map((entry) => (
                  <div class="audit-entry" key={entry.id}>
                    <time>{new Date(entry.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
                    <div><strong>{entry.action}</strong><p>{entry.detail}</p></div>
                    <span>{entry.stableIds.length ? `${entry.stableIds.length} 件` : '系统'}</span>
                  </div>
                ))}
              </div>
            </Tabs.Panel>

            <Tabs.Panel class="tab-panel">
              <div class="batch-list">
                {state.importBatches.length === 0 && <div class="empty-state">还没有导入过比对包。</div>}
                {state.importBatches.map((batch) => (
                  <div class={`batch-card ${batch.finishedAt ? '' : 'open'}`} key={batch.packageId}>
                    <div class="batch-head">
                      <code>{batch.packageId}</code>
                      <span class={`status ${batch.finishedAt ? 'confirmed' : 'suggested'}`}>
                        {batch.finishedAt ? '已完成' : '中断待续传'}
                      </span>
                    </div>
                    <p>包版本 v{batch.packageVersion}{batch.packageVersion < 2 ? '（旧版兼容导入）' : ''}</p>
                    <div class="progress"><i style={`width:${Math.round((batch.processedKeys.length / Math.max(1, batch.totalItems)) * 100)}%`} /></div>
                    <small>{batch.processedKeys.length}/{batch.totalItems} 条目已落盘 · 重试同包自动跳过</small>
                  </div>
                ))}
              </div>
            </Tabs.Panel>

            <Tabs.Panel class="tab-panel rules-panel">
              <div class="rule-row"><span>1</span><p>只按<b>拓片号（稳定编号）</b>挂回原记录；本机改编号只动本机号，旧号自动入别名，回传不会错配。</p></div>
              <div class="rule-row"><span>2</span><p>纸张 / 拓工 / 钤印出现分歧时<b>并列保留</b>全部候选；确认前不覆盖任何值。</p></div>
              <div class="rule-row"><span>3</span><p>字段一旦<b>确认</b>即加锁，之后的回传值被挡下并写入审计，不覆盖已确认结果。</p></div>
              <div class="rule-row"><span>4</span><p>同一包按 <code>包号:条目号</code> 幂等；写入中断保留已处理进度，重试跳过已建档条目。</p></div>
              <div class="rule-row"><span>5</span><p>旧版包（中文字段 / 无版本号）自动归一化迁移导入。</p></div>
              <div class="rule-row"><span>6</span><p><b>待裁项清零后</b>才允许更新导出回执包。扫描指纹仅核对提示，不改写数据。</p></div>
              <hr />
              <div class="shortcut-grid">
                <div><kbd>J / K</kbd><span>下一条 / 上一条待裁项</span></div>
                <div><kbd>X</kbd><span>裁定当前待裁项</span></div>
                <div><kbd>Ctrl + I</kbd><span>打开回传导入</span></div>
                <div><kbd>Ctrl + Z / Y</kbd><span>撤销 / 重做</span></div>
              </div>
            </Tabs.Panel>
          </Tabs.Root>
        </section>
      </main>

      {toast.value && <div class="toast">{toast.value}</div>}

      {/* 回传导入 */}
      <Modal.Root bind:show={importOpen} closeOnBackdropClick={false}>
        <Modal.Panel class="modal-panel import-modal">
          <Modal.Header class="modal-header">
            <div><span class="eyebrow">RETURN PACKAGE</span><Modal.Title>外场版本比对包 · 回传对账</Modal.Title></div>
            <Modal.Close class="modal-close">×</Modal.Close>
          </Modal.Header>
          <Modal.Description class="modal-description">
            选择外场编目组导出的比对包（JSON）。系统按拓片号稳定挂回；同包重试自动跳过已处理条目，中断后可选同一包续传；旧版包自动迁移。
          </Modal.Description>

          <div class="import-controls">
            <label class="file-button">选择比对包文件<input type="file" accept=".json" onChange$={(event, element) => readFile(event, element)} /></label>
            {importName.value && <span class="file-picked">已读取：{importName.value}</span>}
          </div>

          {parsedPkg.value && (
            <div class="pkg-preview">
              <div><span>包号</span><code>{parsedPkg.value.packageId}</code></div>
              <div><span>版本</span>{parsedPkg.value.packageVersion < 2
                ? <b class="legacy">v{parsedPkg.value.packageVersion}（旧版，将兼容迁移）</b>
                : <b>v{parsedPkg.value.packageVersion}</b>}</div>
              <div><span>外场导出时间</span>{new Date(parsedPkg.value.exportedAt).toLocaleString('zh-CN')}</div>
              <div><span>条目数</span>{parsedPkg.value.items.length}</div>
              <div class="pkg-items">
                {parsedPkg.value.items.map((item) => {
                  const key = `${parsedPkg.value!.packageId}:${item.itemNo}`;
                  const done = state.importedItems.some((entry) => entry.key === key);
                  const local = state.records.find((r) => r.stableId === item.stableId);
                  return (
                    <div class={`pkg-item ${done ? 'done' : ''}`} key={key}>
                      <code>{item.itemNo}</code>
                      <code>{item.stableId}</code>
                      <span>{item.title}</span>
                      <em>{done ? '已导入·重试将跳过' : local ? '将挂回已有记录' : '将新建档'}</em>
                    </div>
                  );
                })}
              </div>
              <label class="fail-sim">
                <Checkbox.Root bind:checked={simulateFail}>
                  <Checkbox.Indicator>✓</Checkbox.Indicator>
                </Checkbox.Root>
                <span>模拟写入中断，处理 <input
                  type="number" min={1} max={parsedPkg.value.items.length} value={failAfter.value}
                  onInput$={(event) => { failAfter.value = Number((event.target as HTMLInputElement).value) || 1; }}
                  onClick$={(event) => event.stopPropagation()}
                /> 条后停止（用于验证续传与不重复建档）</span>
              </label>
            </div>
          )}

          {parseError.value && <div class="import-error">{parseError.value}</div>}

          {importReport.value && (
            <div class={`import-report ${importReport.value.interrupted ? 'warn' : ''}`}>
              <strong>{importReport.value.interrupted ? '⚠ 写入中断，进度已保留' : '✓ 本轮导入结果'}</strong>
              <ul>
                <li>新建档 {importReport.value.results.filter((r) => r.created).length} 件，挂回已有 {importReport.value.results.filter((r) => !r.created).length} 件</li>
                <li>新增待裁项 {importReport.value.results.flatMap((r) => r.newDisputes).length} 项（并列保留）</li>
                <li>已确认字段被保护未覆盖：{importReport.value.results.reduce((n, r) => n + r.blockedFields.length, 0)} 处</li>
                <li>指纹不一致（仅提示）：{importReport.value.results.filter((r) => r.fingerprintMismatch).length} 件</li>
                {importReport.value.skipped > 0 && <li>重试跳过已处理条目 {importReport.value.skipped} 条，未重复建档</li>}
              </ul>
              {importReport.value.interrupted
                ? <p>已处理 {importReport.value.results.length}/{importReport.value.total} 条。保留此包，点击「续传导入」从断点继续。</p>
                : <p>整包 {importReport.value.total} 条已全部处理完毕。再次导入同一包将全部幂等跳过。</p>}
            </div>
          )}

          <Modal.Footer class="modal-footer">
            <Modal.Close class="button ghost" onClick$={closeImport}>{importReport.value?.interrupted ? '关闭（保留续传）' : '关闭'}</Modal.Close>
            {importReport.value?.interrupted
              ? <button class="button primary" onClick$={resumeImport}>续传导入（不重复建档）</button>
              : <button class="button primary" disabled={!parsedPkg.value} onClick$={() => runImport()}>对账导入</button>}
          </Modal.Footer>
        </Modal.Panel>
      </Modal.Root>

      {/* 裁定 */}
      <Modal.Root bind:show={resolveOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel resolve-modal">
          {(() => {
            const dispute = state.disputes.find((item) => item.id === activeDisputeId.value);
            const record = dispute ? byStable(state, dispute.stableId) : undefined;
            if (!dispute || !record) return <></>;
            const fieldState = record[dispute.field];
            return <>
              <Modal.Header class="modal-header">
                <div><span class="eyebrow">RESOLVE · {DISPUTE_LABELS[dispute.field]}</span><Modal.Title>{record.title}</Modal.Title></div>
                <Modal.Close class="modal-close">×</Modal.Close>
              </Modal.Header>
              <Modal.Description class="modal-description">
                拓片号 <code>{record.stableId}</code> 的{DISPUTE_LABELS[dispute.field]}存在 {dispute.variants.length} 种并列说法。确认后其余候选仍留档备查，但此后回传不得覆盖该结果。
                {fieldState.confirmed && <b class="already-locked">该字段此前已确认为“{fieldState.chosen}”，如要改判请先撤销。</b>}
              </Modal.Description>
              <div class="choice-list">
                {dispute.variants.map((value) => (
                  <label class={`choice-option ${chosenValue.value === value ? 'selected' : ''}`} key={value}>
                    <input type="radio" name="resolve-choice" checked={chosenValue.value === value} onChange$={() => chosenValue.value = value} />
                    <span>{value}</span>
                  </label>
                ))}
                <label class="choice-option custom">
                  <input type="radio" name="resolve-choice" checked={!dispute.variants.includes(chosenValue.value)} onChange$={() => chosenValue.value = ''} />
                  <input
                    class="input custom-input"
                    placeholder="另填一个裁定值（也会并入候选留档）"
                    value={dispute.variants.includes(chosenValue.value) ? '' : chosenValue.value}
                    onInput$={(event) => { chosenValue.value = (event.target as HTMLInputElement).value; }}
                  />
                </label>
              </div>
              <Modal.Footer class="modal-footer">
                <Modal.Close class="button ghost">取消</Modal.Close>
                <button class="button primary" onClick$={applyResolve} disabled={fieldState.confirmed}>确认并锁定该字段</button>
              </Modal.Footer>
            </>;
          })()}
        </Modal.Panel>
      </Modal.Root>

      {/* 改本机编号 */}
      <Modal.Root bind:show={renameOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel small-modal">
          <Modal.Header class="modal-header">
            <div><span class="eyebrow">LOCAL NUMBER</span><Modal.Title>修改本机编号</Modal.Title></div>
            <Modal.Close class="modal-close">×</Modal.Close>
          </Modal.Header>
          {(() => {
            const record = byStable(state, renameTargetId.value);
            if (!record) return <></>;
            return <Modal.Description class="modal-description">
              稳定拓片号 <code>{record.stableId}</code> 永不改变，是回传挂接的唯一依据。当前本机编号 <b>{record.localNo}</b> 将移入曾用编号别名。
              <input class="input rename-input" value={renameValue.value} onInput$={(event) => renameValue.value = (event.target as HTMLInputElement).value} />
            </Modal.Description>;
          })()}
          <Modal.Footer class="modal-footer">
            <Modal.Close class="button ghost">取消</Modal.Close>
            <button class="button primary" onClick$={applyRename}>保存本机编号</button>
          </Modal.Footer>
        </Modal.Panel>
      </Modal.Root>
    </div>
  );
});
