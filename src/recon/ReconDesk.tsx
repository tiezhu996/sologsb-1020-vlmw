import { $, component$, useComputed$, useSignal, useStore, useVisibleTask$ } from '@builder.io/qwik';
import { Modal, Tabs } from '@qwik-ui/headless';
import type { AdjudicationItem, DisputedField, ReconState, RubbingRecord } from './types';
import {
  adjudicateItem, appendAudit, buildExport, canExport, dismissItem, exportBlockReason,
  fieldLabel, importPacket, pendingCount, sealsToText, seedReconState, toggleRecordLock
} from './engine';
import { sampleFingerprintOnlyPacket, sampleLegacyV1Packet, sampleV2Packet } from './samplePackets';

const STORAGE_KEY = 'sologsb-1020-rubbing-recon-v2';

const shortFp = (fingerprint: string) => fingerprint ? fingerprint.replace(/^sha256:/, '').slice(0, 10) : '—';
const fieldPending = (record: RubbingRecord, field: DisputedField) =>
  record.disputed[field].choice.resolution === 'pending';
const variantCount = (record: RubbingRecord, field: DisputedField) => record.disputed[field].variants.length;
const originLabel = (origin: string) => origin === 'local' ? '本机' : origin === 'incoming' ? '回传' : '裁定';

export default component$(() => {
  const state = useStore<ReconState>(seedReconState());
  const activeRecordId = useSignal('');
  const panelTab = useSignal(0);
  const query = useSignal('');
  const importOpen = useSignal(false);
  const importRaw = useSignal('');
  const importName = useSignal('');
  const toast = useSignal('');
  const lastSummary = useSignal('');
  const editingAdjId = useSignal('');
  const customValue = useSignal('');

  const notify = (message: string) => {
    toast.value = message;
    window.setTimeout(() => { if (toast.value === message) toast.value = ''; }, 3600);
  };

  const filteredRecords = useComputed$(() => {
    const term = query.value.trim().toLowerCase();
    const list = [...state.records].sort((a, b) => a.stableNo.localeCompare(b.stableNo, 'zh'));
    if (!term) return list;
    return list.filter((record) => [
      record.stableNo, record.rubbingNo, record.copyBatch, record.stone,
      record.fingerprint, record.paper, record.rubber, sealsToText(record.seals), record.notes
    ].join(' ').toLowerCase().includes(term));
  });

  const activeRecord = useComputed$(() =>
    state.records.find((record) => record.id === activeRecordId.value) ?? filteredRecords.value[0]
  );

  const pendingItems = useComputed$(() => state.adjudications.filter((item) => item.status === 'pending'));
  const lockedCount = useComputed$(() => state.records.filter((record) => record.recordLocked).length);

  const runImport = $(() => {
    const raw = importRaw.value.trim();
    if (!raw) return;
    try {
      const summary = importPacket(state, raw);
      lastSummary.value = [
        `${summary.migrated ? '旧版 v1 包已迁移导入' : 'v2 包导入完成'}：本文件共 ${summary.totalEntries} 条`,
        `本次处理 ${summary.processedNow} 条 · 幂等跳过 ${summary.skippedAlreadyDone} 条${summary.resumed ? '（中断续跑）' : ''}`,
        `稳定编号/指纹挂回 ${summary.linked} 条（指纹兜底 ${summary.relinkedByFingerprint}）· 新建 ${summary.created} 条`,
        `新增分歧待裁 ${summary.conflictsRaised} 项`
      ].join('；');
      notify(summary.finished ? '比对包已全部入账' : '已保留进度：再次导入同一包即可续跑，不会重复建档');
      if (!activeRecordId.value && state.records.length) activeRecordId.value = state.records[0].id;
      importRaw.value = '';
      importName.value = '';
      importOpen.value = false;
      if (summary.conflictsRaised) panelTab.value = 1;
    } catch (error) {
      notify(`导入失败：${error instanceof Error ? error.message : '比对包格式不正确'}`);
    }
  });

  const readFile = $(async (_event: Event, element: HTMLInputElement) => {
    const file = element.files?.[0];
    if (!file) return;
    importRaw.value = await file.text();
    importName.value = file.name;
  });

  const loadSample = $((kind: 'v2' | 'fp' | 'v1') => {
    if (kind === 'v2') importRaw.value = JSON.stringify(sampleV2Packet(), null, 2);
    else if (kind === 'fp') importRaw.value = JSON.stringify(sampleFingerprintOnlyPacket(), null, 2);
    else importRaw.value = sampleLegacyV1Packet();
    importName.value = '';
  });

  const resolve = $((item: AdjudicationItem, resolution: 'local' | 'incoming' | 'adjudicated') => {
    try {
      if (resolution === 'adjudicated') {
        if (!customValue.value.trim()) { notify('请先填写手工裁定内容'); return; }
        adjudicateItem(state, item.id, 'adjudicated', customValue.value);
      } else {
        adjudicateItem(state, item.id, resolution);
      }
      editingAdjId.value = '';
      customValue.value = '';
      notify('待裁项已处理，并列候选与裁定依据已写入审计');
    } catch (error) {
      notify(error instanceof Error ? error.message : '裁决失败');
    }
  });

  const shelve = $((item: AdjudicationItem) => {
    dismissItem(state, item.id);
    notify('已搁置：候选仍并列保留，导出不受阻塞，可随时重开');
  });

  const exportPack = $(() => {
    if (!canExport(state)) { notify(exportBlockReason(state)); return; }
    const payload = buildExport(state);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `拓片版本对账导出-r${state.revision}-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    appendAudit(state, '更新导出包', `按 r${state.revision} 导出台账 ${payload.records.length} 条、裁决记录 ${payload.adjudications.length} 条、回执 ${payload.receipts.length} 份`);
    notify('导出包已更新（待裁项均已处理完毕）');
  });

  useVisibleTask$(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as ReconState;
        state.revision = saved.revision ?? state.revision;
        state.records = saved.records ?? state.records;
        state.adjudications = saved.adjudications ?? state.adjudications;
        state.receipts = saved.receipts ?? state.receipts;
        state.audit = saved.audit ?? state.audit;
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
    state.hydrated = true;
  });

  useVisibleTask$(({ track }) => {
    const payload = track(() => JSON.stringify({
      revision: state.revision, records: state.records, adjudications: state.adjudications,
      receipts: state.receipts, audit: state.audit
    }));
    if (state.hydrated) localStorage.setItem(STORAGE_KEY, payload);
  });

  const fields: Array<[DisputedField, string]> = [['paper', '纸张'], ['rubber', '拓工'], ['seals', '钤印']];

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-seal">拓</div>
          <div><h1>碑帖拓片版本比对台</h1><p>RUBBING VERSION RECONCILIATION</p></div>
        </div>
        <div class="top-stat"><span class="online-dot" />{state.hydrated ? `离线保存 · r${state.revision}` : '正在恢复本地工作区'}</div>
        <div class="top-actions">
          <button class="button ghost" onClick$={() => importOpen.value = true}>回传对账（导入比对包）</button>
          <button class="button light" disabled={!canExport(state)} title={canExport(state) ? '待裁项清零，可更新导出包' : exportBlockReason(state)} onClick$={exportPack}>
            更新导出包
          </button>
        </div>
      </header>

      <div class="overview">
        <div>
          <span class="eyebrow">RETURN-PACKET RECONCILIATION</span>
          <h2>外场版本比对包回传对账</h2>
          <p>以稳定编号挂回原记录（本机改号靠指纹兜底）；纸张、拓工、钤印分歧并列保留，确认前不覆盖；写入中断可续跑，重试不重复建档。</p>
        </div>
        <div class="metrics">
          <div><strong>{state.records.length}</strong><span>台账拓片</span></div>
          <div><strong>{lockedCount.value}</strong><span>已确认（受保护）</span></div>
          <div class={pendingCount(state) ? 'danger' : ''}><strong>{pendingCount(state)}</strong><span>待裁项</span></div>
          <div><strong>{state.receipts.length}</strong><span>入账比对包</span></div>
        </div>
      </div>

      <main class="desk-grid recon-grid">
        {/* 左：回执与导入 */}
        <section class="panel">
          <div class="panel-heading">
            <div><span class="eyebrow">01 / PACKETS</span><h3>比对包入账回执</h3></div>
            <button class="button small primary" onClick$={() => importOpen.value = true}>导入</button>
          </div>
          <div class="receipt-list">
            {state.receipts.map((receipt) => (
              <article class="receipt-card" key={receipt.packetId}>
                <div class="receipt-top">
                  <code>{receipt.packetId}</code>
                  <span class={`status ${receipt.finishedAt ? 'confirmed' : 'suggested'}`}>
                    {receipt.finishedAt ? '已入账' : '中断 · 可续跑'}
                  </span>
                </div>
                <div class="progress">
                  <div style={{ width: `${Math.min(100, Math.round((receipt.entriesProcessed / Math.max(1, receipt.totalEntries)) * 100))}%` }} />
                </div>
                <p>
                  v{receipt.schemaVersionImported} · {receipt.source} · 进度 {receipt.entriesProcessed}/{receipt.totalEntries}
                  <br />挂回 {receipt.linked}（指纹兜底 {receipt.relinkedByFingerprint}）· 新建 {receipt.created} · 分歧 {receipt.conflictsRaised}
                </p>
              </article>
            ))}
            {!state.receipts.length && <div class="empty-state">还没有比对包入账。<br />点击「回传对账」导入外场带回的版本比对包。</div>}
          </div>
          {lastSummary.value && <div class="summary-line">{lastSummary.value}</div>}
        </section>

        {/* 中：拓片台账 */}
        <section class="panel">
          <div class="panel-heading">
            <div><span class="eyebrow">02 / LEDGER</span><h3>拓片台账（稳定编号挂接）</h3></div>
            <span class="shortcut-hint">{filteredRecords.value.length} 条</span>
          </div>
          <div class="toolbar-row">
            <input class="input search" placeholder="搜拓片号 / 批次 / 原石 / 指纹" value={query.value}
              onInput$={(event) => { query.value = (event.target as HTMLInputElement).value; }} />
          </div>
          <div class="record-table">
            <div class="table-head recon-head"><span>稳定编号 / 拓片号</span><span>摹刻批次 · 原石</span><span>纸 / 工 / 印</span><span>状态</span></div>
            {filteredRecords.value.map((record) => {
              const disputes = (['paper', 'rubber', 'seals'] as DisputedField[]).filter((field) => fieldPending(record, field));
              return (
                <div class={`table-row recon-row ${activeRecord.value?.id === record.id ? 'active-row' : ''}`} key={record.id}
                  onClick$={() => { activeRecordId.value = record.id; panelTab.value = 0; }}>
                  <span>
                    <strong>{record.stableNo}</strong>
                    <small>拓片号：{record.rubbingNo} · {shortFp(record.fingerprint)}</small>
                  </span>
                  <span>{record.copyBatch}<small>{record.stone}</small>{record.linkAliases.length > 0 && <small class="alias-note">指纹别名挂接 ×{record.linkAliases.length}</small>}</span>
                  <span class="triple-field">
                    {(['paper', 'rubber', 'seals'] as DisputedField[]).map((field) => (
                      <em key={field} class={fieldPending(record, field) ? 'has-conflict' : ''}
                        title={fieldPending(record, field) ? `${fieldLabel(field)}有 ${variantCount(record, field)} 个并列候选待裁` : fieldLabel(field)}>
                        {fieldLabel(field)[0]}{fieldPending(record, field) ? '!' : '·'}{variantCount(record, field) || ''}
                      </em>
                    ))}
                  </span>
                  <span class={`record-status ${record.recordLocked ? 'confirmed' : ''}`}>
                    {record.recordLocked ? '已确认' : disputes.length ? `${disputes.length} 项待裁` : '在账'}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        {/* 右：详情 / 待裁 / 审计 */}
        <section class="panel">
          <Tabs.Root bind:selectedIndex={panelTab} class="review-tabs">
            <Tabs.List class="tab-list">
              <Tabs.Tab>记录详情</Tabs.Tab>
              <Tabs.Tab>待裁项 {pendingItems.value.length ? `(${pendingItems.value.length})` : ''}</Tabs.Tab>
              <Tabs.Tab>审计轨迹</Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel class="tab-panel">
              {activeRecord.value ? (() => {
                const record = activeRecord.value!;
                return <div class="detail-pane">
                  <div class="detail-title">
                    <div><span class="eyebrow">STABLE NO.</span><h4>{record.stableNo}</h4></div>
                    <button class={`button small ${record.recordLocked ? 'confirm' : 'ghost'}`}
                      onClick$={() => toggleRecordLock(state, record.id)}>
                      {record.recordLocked ? '✓ 已确认（回传不覆盖）' : '确认此记录'}
                    </button>
                  </div>
                  <dl class="detail-grid">
                    <dt>拓片号</dt><dd>{record.rubbingNo}{record.linkAliases.length > 0 && <small> 外场曾用号见下方挂接别名</small>}</dd>
                    <dt>摹刻批次</dt><dd>{record.copyBatch || '—'}</dd>
                    <dt>原石</dt><dd>{record.stone || '—'}</dd>
                    <dt>扫描指纹</dt><dd><code>{record.fingerprint || '—'}</code></dd>
                    <dt>备注</dt><dd>{record.notes || '—'}</dd>
                  </dl>

                  {fields.map(([field, label]) => {
                    const block = record.disputed[field];
                    const canonical = field === 'seals' ? sealsToText(record.seals) : String(record[field]);
                    const pending = fieldPending(record, field);
                    return (
                      <div class={`variant-block ${pending ? 'pending' : ''}`} key={field}>
                        <div class="variant-head">
                          <strong>{label}</strong>
                          {pending
                            ? <span class="status suggested">待裁 · {block.variants.length} 说并列</span>
                            : <span class="status confirmed">已定</span>}
                        </div>
                        <div class="canonical">当前正式值：{canonical || '—'}</div>
                        {block.variants.length > 0 && <ul class="variant-list">
                          {block.variants.map((variant, index) => (
                            <li key={`${variant.origin}-${index}`} class={block.choice.chosenVariantIndex === index ? 'chosen' : ''}>
                              <span class={`origin-tag ${variant.origin}`}>{originLabel(variant.origin)}</span>
                              {variant.value}{variant.packetId && <small>（{variant.packetId}）</small>}
                            </li>
                          ))}
                        </ul>}
                      </div>
                    );
                  })}

                  {record.linkAliases.length > 0 && <div class="alias-block">
                    <strong>挂接别名（本机改号 / 指纹兜底记录）</strong>
                    <ul>{record.linkAliases.map((alias, index) => (
                      <li key={index}>外场号 {alias.rubbingNo || '—'} · 指纹 {shortFp(alias.fingerprint)} · {alias.packetId} · {new Date(alias.at).toLocaleString('zh-CN')}</li>
                    ))}</ul>
                  </div>}
                </div>;
              })() : <div class="empty-state">台账为空，请先导入比对包。</div>}
            </Tabs.Panel>

            <Tabs.Panel class="tab-panel">
              <div class="adj-list">
                {state.adjudications.map((item) => {
                  const record = state.records.find((candidate) => candidate.id === item.recordId);
                  return (
                    <article class={`adj-card ${item.status}`} key={item.id}>
                      <div class="adj-head">
                        <strong>{record?.rubbingNo ?? item.stableNo}</strong>
                        <span class="eyebrow">{item.stableNo} · {fieldLabel(item.field)}</span>
                        <span class={`status ${item.status === 'pending' ? 'suggested' : item.status === 'resolved' ? 'confirmed' : 'rejected'}`}>
                          {item.status === 'pending' ? '待裁' : item.status === 'resolved' ? '已裁定' : '已搁置'}
                        </span>
                      </div>
                      <ul class="variant-list tight">
                        {item.variants.map((variant, index) => (
                          <li key={index}><span class={`origin-tag ${variant.origin}`}>{originLabel(variant.origin)}</span>{variant.value}</li>
                        ))}
                      </ul>
                      {item.status === 'pending' ? <>
                        <div class="adj-actions">
                          <button class="button small ghost" onClick$={() => resolve(item, 'local')}>保留本机值</button>
                          <button class="button small primary" onClick$={() => resolve(item, 'incoming')}>采用回传值</button>
                          <button class="button small ghost" onClick$={() => { editingAdjId.value = item.id; customValue.value = ''; }}>手工裁定</button>
                          <button class="button small ghost" onClick$={() => shelve(item)}>搁置（维持本机值）</button>
                        </div>
                        {editingAdjId.value === item.id && <div class="custom-row">
                          <input class="input search" value={customValue.value} placeholder="输入裁定后的最终文本"
                            onInput$={(event) => customValue.value = (event.target as HTMLInputElement).value} />
                          <button class="button small confirm" onClick$={() => resolve(item, 'adjudicated')}>确认裁定</button>
                        </div>}
                      </> : <p class="resolved-note">
                        {item.resolution === 'local' ? '保留本机值' : item.resolution === 'incoming' ? '采用回传值' : '手工裁定'}
                        {item.chosenValue ? `：${item.chosenValue}` : ''} · {item.resolvedAt ? new Date(item.resolvedAt).toLocaleString('zh-CN') : ''}
                      </p>}
                    </article>
                  );
                })}
                {!state.adjudications.length && <div class="empty-state">没有待裁项。<br />纸张、拓工、钤印出现分歧时，会在此并列候选等待裁决，确认前不会覆盖正式值。</div>}
              </div>
            </Tabs.Panel>

            <Tabs.Panel class="tab-panel">
              <div class="audit-list recon-audit">
                {state.audit.slice(0, 60).map((entry) => (
                  <div class="audit-entry" key={entry.id}>
                    <time>{new Date(entry.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
                    <div><strong>{entry.action}</strong><p>{entry.detail}</p></div>
                    <span>{entry.packetId ? '回传包' : entry.recordIds.length ? `${entry.recordIds.length} 条` : '系统'}</span>
                  </div>
                ))}
              </div>
            </Tabs.Panel>
          </Tabs.Root>
        </section>
      </main>

      <section class="bottom-grid">
        <article class="panel explanation-panel">
          <div class="panel-heading"><div><span class="eyebrow">RULES</span><h3>对账保护规则</h3></div></div>
          <div class="rule-row"><span>1</span><p>先用包里的<b>稳定编号</b>挂回原记录；本机改过拓片号时，用<b>扫描指纹</b>兜底，绝不错配，挂接别名全程留痕。</p></div>
          <div class="rule-row"><span>2</span><p>纸张、拓工、钤印有分歧时<b>并列保留</b>所有说法并开待裁项；记录一旦确认，回传只追加候选，<b>确认前不覆盖</b>已确认结果。</p></div>
          <div class="rule-row"><span>3</span><p>写入中断后凭回执保留进度，重试同一包按幂等键跳过已处理条目，<b>不重复建档</b>；旧版 v1 包自动迁移导入。</p></div>
          <div class="rule-row"><span>4</span><p>全部待裁项处理完后才允许更新导出包；搁置项不阻塞导出但仍留痕。</p></div>
        </article>
        <article class="panel explanation-panel">
          <div class="panel-heading"><div><span class="eyebrow">PACKET FORMAT</span><h3>比对包字段</h3></div></div>
          <p>拓片号 rubbingNo · 摹刻批次 copyBatch · 原石 stone · 扫描指纹 fingerprint · 纸张 paper · 拓工 rubber · 钤印 seals[]（印文 + 位置）。旧版包使用 stable_id / batch / stele / scan_hash / paper_type / artisan / seals_text，会自动迁移。</p>
        </article>
      </section>

      {toast.value && <div class="toast">{toast.value}</div>}

      <Modal.Root bind:show={importOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel import-modal">
          <Modal.Header class="modal-header">
            <div><span class="eyebrow">RETURN PACKET</span><Modal.Title>回传对账：导入版本比对包</Modal.Title></div>
            <Modal.Close class="modal-close">×</Modal.Close>
          </Modal.Header>
          <Modal.Description class="modal-description">
            支持当前 v2 包与旧版 v1 包（自动迁移）。重复导入同一包会跳过已处理条目；上次中断的包再次导入即从断点续跑，不会重复建档。
          </Modal.Description>
          <div class="import-controls">
            <label class="file-button">选择比对包文件<input type="file" accept=".json,.txt" onChange$={(event, element) => readFile(event, element)} /></label>
            <button class="button small ghost" onClick$={() => loadSample('v2')}>填入示例 v2 包</button>
            <button class="button small ghost" onClick$={() => loadSample('fp')}>指纹兜底示例包</button>
            <button class="button small ghost" onClick$={() => loadSample('v1')}>填入旧版 v1 包</button>
          </div>
          <textarea class="modal-textarea recon-textarea" value={importRaw.value}
            onInput$={(event) => importRaw.value = (event.target as HTMLTextAreaElement).value}
            placeholder='{"packetId":"PK-...","schemaVersion":2,"entries":[{"stableNo":"STB-...","rubbingNo":"拓甲-0145",...}]}' />
          {importName.value && <div class="file-name">已读取：{importName.value}</div>}
          <Modal.Footer class="modal-footer">
            <Modal.Close class="button ghost">取消</Modal.Close>
            <button class="button primary" disabled={!importRaw.value.trim()} onClick$={runImport}>挂回并入账</button>
          </Modal.Footer>
        </Modal.Panel>
      </Modal.Root>
    </div>
  );
});
