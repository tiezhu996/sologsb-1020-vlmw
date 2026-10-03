import type {
  AdjudicationItem, DisputedField, FieldResolution, FieldVariant,
  ImportReceipt, LegacyPacketEntry, LegacyReconPacket, PacketEntry,
  ReconAuditEntry, ReconExport, ReconPacket, ReconState, RubbingRecord, SealMark
} from './types';

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

const now = () => new Date().toISOString();
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

const compact = (value: string) => value.trim().replace(/\s+/g, '');

export const sealsToText = (seals: SealMark[]) => seals
  .map((seal) => (seal.position ? `${seal.text}（${seal.position}）` : seal.text))
  .join('；');

/** 钤印第 n 枚（从 1 起） */
export const sealLabel = (index: number) => `第 ${index + 1} 枚`;

const DISPUTED_FIELDS: DisputedField[] = ['paper', 'rubber', 'seals'];

const emptyDisputed = (): RubbingRecord['disputed'] => ({
  paper: { variants: [], choice: { resolution: 'local' } },
  rubber: { variants: [], choice: { resolution: 'local' } },
  seals: { variants: [], choice: { resolution: 'local' } }
});

export const makeRecord = (partial: Partial<RubbingRecord> & Pick<RubbingRecord, 'stableNo' | 'rubbingNo'>): RubbingRecord => ({
  id: uid('rec'),
  stableNo: partial.stableNo,
  rubbingNo: partial.rubbingNo,
  copyBatch: partial.copyBatch ?? '',
  stone: partial.stone ?? '',
  fingerprint: partial.fingerprint ?? '',
  paper: partial.paper ?? '',
  rubber: partial.rubber ?? '',
  seals: partial.seals ?? [],
  notes: partial.notes ?? '',
  createdAt: now(),
  updatedAt: now(),
  recordLocked: partial.recordLocked ?? false,
  disputed: partial.disputed ?? emptyDisputed(),
  linkAliases: partial.linkAliases ?? []
});

/* ------------------------------------------------------------------ */
/* 旧版包（v1）迁移                                                    */
/* ------------------------------------------------------------------ */

/** 把 “端方之印（右下）” 这类自由文本拆成结构化钤印 */
const parseSealsText = (text: string): SealMark[] => text
  .split(/[；;\n]+/)
  .map((part) => part.trim())
  .filter(Boolean)
  .map((part) => {
    const matched = part.match(/^(.+?)[（(](.+?)[)）]\s*$/);
    return matched ? { text: matched[1].trim(), position: matched[2].trim() } : { text: part, position: '' };
  });

const migrateEntry = (item: LegacyPacketEntry): PacketEntry => ({
  stableNo: item.stable_id ?? '',
  rubbingNo: item.rubbing_id ?? '',
  copyBatch: item.batch ?? '',
  stone: item.stele ?? '',
  fingerprint: item.scan_hash ?? '',
  paper: item.paper_type ?? '',
  rubber: item.artisan ?? '',
  seals: parseSealsText(item.seals_text ?? '')
});

/** 解析任意版本的比对包，旧版（v1）自动迁移为 v2；格式错误抛异常 */
export function parsePacket(raw: string): { packet: ReconPacket; migrated: boolean } {
  const data = JSON.parse(raw) as Partial<ReconPacket> & LegacyReconPacket;
  const version = (data.schemaVersion ?? data.version ?? 1) as number;
  const rawEntries = (data.entries ?? data.items ?? []) as Array<PacketEntry | LegacyPacketEntry>;

  if (version >= 2) {
    const entries = (rawEntries as PacketEntry[]).map((entry) => ({
      stableNo: String(entry.stableNo ?? '').trim(),
      rubbingNo: String(entry.rubbingNo ?? '').trim(),
      copyBatch: String(entry.copyBatch ?? '').trim(),
      stone: String(entry.stone ?? '').trim(),
      fingerprint: String(entry.fingerprint ?? '').trim().toLowerCase(),
      paper: String(entry.paper ?? '').trim(),
      rubber: String(entry.rubber ?? '').trim(),
      seals: Array.isArray(entry.seals)
        ? entry.seals.map((seal) => ({ text: String(seal.text ?? '').trim(), position: String(seal.position ?? '').trim() }))
        : [],
      packetRev: entry.packetRev
    }));
    const packet: ReconPacket = {
      packetId: String(data.packetId ?? '').trim(),
      schemaVersion: 2,
      exportedAt: String(data.exportedAt ?? now()),
      source: String(data.source ?? '外场编目组'),
      entries
    };
    if (!packet.packetId) throw new Error('比对包缺少 packetId');
    return { packet, migrated: false };
  }

  // v1 → v2
  const legacy = data as LegacyReconPacket;
  const entries = (legacy.items ?? legacy.entries ?? []).map(migrateEntry);
  const packet: ReconPacket = {
    packetId: String(legacy.packetId ?? legacy.id ?? `legacy-${compact(legacy.exported_at ?? now()).slice(0, 12)}`),
    schemaVersion: 2,
    exportedAt: String(legacy.exported_at ?? legacy.exportedAt ?? now()),
    source: String(legacy.team ?? legacy.source ?? '外场编目组（旧版包 v1）'),
    entries
  };
  if (!packet.packetId) throw new Error('旧版比对包缺少编号');
  return { packet, migrated: true };
}

/* ------------------------------------------------------------------ */
/* 挂接：稳定编号优先，指纹兜底，绝不因本机改号错配                     */
/* ------------------------------------------------------------------ */

type LinkReason = 'stableNo' | 'fingerprint' | 'rubbingNo+batch' | 'created';

function findLink(entry: PacketEntry, records: RubbingRecord[]): { record?: RubbingRecord; reason: LinkReason } {
  // 1) 稳定编号直接挂回（即便本机改过拓片号也不受影响）
  const byStable = records.find((record) => compact(record.stableNo) === compact(entry.stableNo));
  if (byStable) return { record: byStable, reason: 'stableNo' };

  // 2) 扫描指纹：内容级证据，仅在稳定编号缺失/对不上时兜底
  if (entry.fingerprint) {
    const byFingerprint = records.find(
      (record) => compact(record.fingerprint) === compact(entry.fingerprint)
        || record.linkAliases.some((alias) => compact(alias.fingerprint) === compact(entry.fingerprint))
    );
    if (byFingerprint) return { record: byFingerprint, reason: 'fingerprint' };
  }

  // 3) 拓片号 + 摹刻批次（同为业务主键的组合）
  if (entry.rubbingNo && entry.copyBatch) {
    const byRubbing = records.find(
      (record) => compact(record.rubbingNo) === compact(entry.rubbingNo) && compact(record.copyBatch) === compact(entry.copyBatch)
    );
    if (byRubbing) return { record: byRubbing, reason: 'rubbingNo+batch' };
  }

  return { reason: 'created' };
}

/* ------------------------------------------------------------------ */
/* 分歧并列候选                                                        */
/* ------------------------------------------------------------------ */

const variantKey = (value: string) => compact(value).toLowerCase();

function pushVariant(variants: FieldVariant[], candidate: FieldVariant): boolean {
  if (!candidate.value.trim()) return false;
  const key = variantKey(candidate.value);
  if (variants.some((existing) => variantKey(existing.value) === key)) return false;
  variants.push(candidate);
  return true;
}

/** 记录上三个分歧字段的当前取值（展示用文本） */
export function canonicalText(record: RubbingRecord, field: DisputedField): string {
  return field === 'seals' ? sealsToText(record.seals) : String(record[field]);
}

function entryFieldText(entry: PacketEntry, field: DisputedField): string {
  return field === 'seals' ? sealsToText(entry.seals) : String(entry[field]);
}

/** 生成本机现存候选（首次出现分歧时把已确认的本机值也并入并列列表） */
function ensureLocalVariant(record: RubbingRecord, field: DisputedField) {
  const state = record.disputed[field];
  const localText = canonicalText(record, field);
  if (localText) {
    pushVariant(state.variants, {
      value: localText,
      origin: 'local',
      receivedAt: record.updatedAt,
      ...(field === 'seals' ? { seals: record.seals.map((seal) => ({ ...seal })) } : {})
    });
  }
}

function raiseAdjudication(
  state: ReconState,
  record: RubbingRecord,
  field: DisputedField,
  packetId: string,
  variants: FieldVariant[]
) {
  // 同一包、同一记录、同一字段的待裁项不重复开单
  const duplicated = state.adjudications.some(
    (item) => item.status === 'pending' && item.recordId === record.id && item.field === field && item.packetId === packetId
  );
  if (duplicated) return;
  const item: AdjudicationItem = {
    id: uid('adj'),
    recordId: record.id,
    stableNo: record.stableNo,
    field,
    packetId,
    status: 'pending',
    createdAt: now(),
    variants: variants.map((variant) => ({ ...variant }))
  };
  state.adjudications.unshift(item);
}

/* ------------------------------------------------------------------ */
/* 审计 / 修订号                                                       */
/* ------------------------------------------------------------------ */

export function appendAudit(state: ReconState, action: string, detail: string, recordIds: string[] = [], packetId?: string) {
  state.revision += 1;
  const entry: ReconAuditEntry = { id: uid('aud'), at: now(), action, detail, recordIds, packetId };
  state.audit.unshift(entry);
  state.audit = state.audit.slice(0, 400);
}

/* ------------------------------------------------------------------ */
/* 导入（幂等、可续跑、旧版可导入）                                     */
/* ------------------------------------------------------------------ */

export interface ImportSummary {
  packetId: string;
  migrated: boolean;
  resumed: boolean;
  totalEntries: number;
  processedNow: number;
  skippedAlreadyDone: number;
  linked: number;
  relinkedByFingerprint: number;
  created: number;
  conflictsRaised: number;
  finished: boolean;
}

const entryKey = (packetId: string, entry: PacketEntry) => [
  packetId, entry.stableNo, entry.rubbingNo, entry.copyBatch, entry.fingerprint
].map(compact).join('|');

/**
 * 导入一个比对包。
 * - 重试同一包：已处理条目按幂等键跳过，绝不重复建档；
 * - 写入中断：receipt 记录 entriesProcessed / processedKeys，再次导入即续跑；
 * - 旧版包：parsePacket 已迁移为 v2。
 */
export function importPacket(state: ReconState, raw: string): ImportSummary {
  const { packet, migrated } = parsePacket(raw);

  let receipt = state.receipts.find((item) => item.packetId === packet.packetId);
  const resumed = Boolean(receipt && !receipt.finishedAt);
  const seen = new Set(receipt?.processedKeys ?? []);

  if (!receipt) {
    receipt = {
      packetId: packet.packetId,
      schemaVersionImported: migrated ? 1 : 2,
      startedAt: now(),
      source: packet.source,
      totalEntries: packet.entries.length,
      entriesProcessed: 0,
      linked: 0,
      relinkedByFingerprint: 0,
      created: 0,
      conflictsRaised: 0,
      processedKeys: []
    };
    state.receipts.unshift(receipt);
  }

  const summary: ImportSummary = {
    packetId: packet.packetId,
    migrated,
    resumed,
    totalEntries: packet.entries.length,
    processedNow: 0,
    skippedAlreadyDone: 0,
    linked: 0,
    relinkedByFingerprint: 0,
    created: 0,
    conflictsRaised: 0,
    finished: false
  };

  for (const entry of packet.entries) {
    const key = entryKey(packet.packetId, entry);
    if (seen.has(key)) {
      summary.skippedAlreadyDone += 1;
      continue;
    }

    const { record: linked, reason } = findLink(entry, state.records);
    let record: RubbingRecord;

    if (linked) {
      record = linked;
      summary.linked += 1;
      if (reason === 'stableNo') receipt.linked += 1;
      if (reason === 'fingerprint') {
        receipt.relinkedByFingerprint += 1;
        summary.relinkedByFingerprint += 1;
        // 指纹兜底挂回：登记别名，但本机稳定编号保持不动，避免错配扩散
        record.linkAliases.push({
          stableNo: entry.stableNo,
          rubbingNo: entry.rubbingNo,
          fingerprint: entry.fingerprint,
          packetId: packet.packetId,
          at: now()
        });
      }
    } else {
      record = makeRecord({
        stableNo: entry.stableNo || `STABLE-LOCAL-${receipt.processedKeys.length + 1}`,
        rubbingNo: entry.rubbingNo,
        copyBatch: entry.copyBatch,
        stone: entry.stone,
        fingerprint: entry.fingerprint,
        paper: entry.paper,
        rubber: entry.rubber,
        seals: entry.seals
      });
      state.records.push(record);
      receipt.created += 1;
      summary.created += 1;
    }

    // 已确认（锁定）记录：只追加并列候选与待裁项，绝不覆盖正式字段
    // 未锁定记录：标识列空白可补、已填不改
    if (!record.recordLocked) {
      if (!record.stone && entry.stone) record.stone = entry.stone;
      if (!record.fingerprint && entry.fingerprint) record.fingerprint = entry.fingerprint;
      if (!record.copyBatch && entry.copyBatch) record.copyBatch = entry.copyBatch;
    }

    // 纸张 / 拓工 / 钤印：有分歧则并列保留并开待裁项，确认前不覆盖
    for (const field of DISPUTED_FIELDS) {
      const incomingText = entryFieldText(entry, field);
      const localText = canonicalText(record, field);
      if (!incomingText) continue;
      if (localText && variantKey(incomingText) === variantKey(localText)) continue;

      ensureLocalVariant(record, field);
      const added = pushVariant(record.disputed[field].variants, {
        value: incomingText,
        origin: 'incoming',
        packetId: packet.packetId,
        receivedAt: packet.exportedAt,
        ...(field === 'seals' ? { seals: entry.seals.map((seal) => ({ ...seal })) } : {})
      });
      if (added) {
        // 出现新分歧：候选并列、字段挂起待裁；正式值保持原样不被覆盖
        // （对已裁决字段出现新说法同理——不回退已定的正式值，只重新进入待裁）
        if (record.disputed[field].choice.resolution !== 'pending') {
          record.disputed[field].choice = { resolution: 'pending' };
        }
        raiseAdjudication(state, record, field, packet.packetId, record.disputed[field].variants);
        receipt.conflictsRaised += 1;
        summary.conflictsRaised += 1;
      }
    }

    record.updatedAt = now();

    seen.add(key);
    receipt.processedKeys.push(key);
    receipt.entriesProcessed += 1;
    summary.processedNow += 1;
  }

  // 本文件每一行都已处理或跳过后才收尾；中途中断时 finishedAt 留空，下次导入续跑
  if (summary.processedNow + summary.skippedAlreadyDone >= packet.entries.length) {
    receipt.finishedAt = now();
    summary.finished = true;
  }
  receipt.totalEntries = packet.entries.length;

  appendAudit(
    state,
    summary.skippedAlreadyDone && !summary.processedNow ? '重试比对包（幂等跳过）' : resumed ? '续跑比对包导入' : '导入比对包',
    [
      `包 ${packet.packetId}（${migrated ? 'v1 旧版迁移' : 'v2'}）`,
      `共 ${packet.entries.length} 条，本次处理 ${summary.processedNow} 条，跳过已处理 ${summary.skippedAlreadyDone} 条`,
      `挂回 ${summary.linked} 条${summary.relinkedByFingerprint ? `（其中指纹兜底 ${summary.relinkedByFingerprint}）` : ''}，新建 ${summary.created} 条`,
      `分歧待裁 ${summary.conflictsRaised} 项`
    ].join('；'),
    [],
    packet.packetId
  );

  return summary;
}

/* ------------------------------------------------------------------ */
/* 待裁项处理                                                          */
/* ------------------------------------------------------------------ */

export function pendingCount(state: ReconState) {
  return state.adjudications.filter((item) => item.status === 'pending').length;
}

/** 裁决一条待裁项：取本机值 / 取回传值 / 手工裁定。写入正式字段。 */
export function adjudicateItem(state: ReconState, itemId: string, resolution: FieldResolution, customValue = '') {
  const item = state.adjudications.find((candidate) => candidate.id === itemId);
  if (!item || item.status !== 'pending') return;
  const record = state.records.find((candidate) => candidate.id === item.recordId);
  if (!record) return;

  let chosen: string;
  if (resolution === 'local') {
    chosen = item.variants.find((variant) => variant.origin === 'local')?.value ?? canonicalText(record, item.field);
  } else if (resolution === 'incoming') {
    const incoming = [...item.variants].reverse().find((variant) => variant.origin === 'incoming');
    chosen = incoming?.value ?? '';
  } else {
    chosen = customValue.trim();
  }
  if (!chosen) throw new Error('裁定内容为空');

  const chosenVariantIndex = item.variants.findIndex((variant) => variantKey(variant.value) === variantKey(chosen));
  if (chosenVariantIndex >= 0) {
    const variant = item.variants[chosenVariantIndex];
    pushVariant(record.disputed[item.field].variants, { ...variant });
  } else {
    pushVariant(record.disputed[item.field].variants, { value: chosen, origin: 'adjudicated', receivedAt: now() });
  }

  // 写回正式字段（钤印优先恢复结构化快照，其次按文本拆分，保留印文与位置）
  if (item.field === 'seals') {
    const snapshotVariant = chosenVariantIndex >= 0 ? item.variants[chosenVariantIndex] : undefined;
    if (snapshotVariant?.seals?.length) {
      record.seals = snapshotVariant.seals.map((seal) => ({ ...seal }));
    } else if (resolution === 'local') {
      // 本机值没有快照时保留现状
    } else {
      record.seals = chosen.split(/[；;\n]+/).map((part) => part.trim()).filter(Boolean).map((part) => {
        const matched = part.match(/^(.+?)[（(](.+?)[)）]\s*$/);
        return matched ? { text: matched[1].trim(), position: matched[2].trim() } : { text: part, position: '' };
      });
    }
  } else {
    record[item.field] = chosen;
  }

  record.disputed[item.field].choice = {
    resolution,
    chosenValue: chosen,
    adjudicatedAt: now(),
    chosenVariantIndex: chosenVariantIndex >= 0 ? chosenVariantIndex : undefined
  };
  record.updatedAt = now();

  item.status = 'resolved';
  item.resolvedAt = now();
  item.resolution = resolution;
  item.chosenValue = chosen;

  appendAudit(
    state,
    '裁决分歧',
    `拓片 ${record.stableNo} 的${fieldLabel(item.field)}：${resolution === 'local' ? '保留本机值' : resolution === 'incoming' ? '采用回传值' : '手工裁定'}「${chosen}」`,
    [record.id],
    item.packetId
  );
}

/** 搁置：人工认定无需处理，候选仍并列保留，待裁项关闭且不阻塞导出；正式值不动 */
export function dismissItem(state: ReconState, itemId: string) {
  const item = state.adjudications.find((candidate) => candidate.id === itemId);
  if (!item || item.status !== 'pending') return;
  const record = state.records.find((candidate) => candidate.id === item.recordId);
  item.status = 'dismissed';
  item.resolvedAt = now();
  if (record) {
    // 该字段没有其他待裁项时，按搁置落定为本机现值，不再挂起
    const otherPending = state.adjudications.some(
      (other) => other.id !== item.id && other.status === 'pending' && other.recordId === record.id && other.field === item.field
    );
    if (!otherPending) {
      record.disputed[item.field].choice = {
        resolution: 'local',
        chosenValue: canonicalText(record, item.field),
        adjudicatedAt: now()
      };
      record.updatedAt = now();
    }
  }
  appendAudit(state, '搁置待裁项', `拓片 ${item.stableNo} 的${fieldLabel(item.field)}分歧搁置处理，候选仍并列保留，正式值维持本机现值`, [item.recordId], item.packetId);
}

/** 整记录确认（锁定）。确认后回传只追加候选，不覆盖任何已确认结果 */
export function toggleRecordLock(state: ReconState, recordId: string) {
  const record = state.records.find((candidate) => candidate.id === recordId);
  if (!record) return;
  record.recordLocked = !record.recordLocked;
  record.updatedAt = now();
  appendAudit(
    state,
    record.recordLocked ? '确认拓片记录' : '解除记录确认',
    `拓片 ${record.stableNo}（${record.rubbingNo}）${record.recordLocked ? '已确认：后续回传仅追加并列候选，不覆盖正式字段' : '重新开放编辑'}`,
    [record.id]
  );
}

export function fieldLabel(field: DisputedField) {
  return field === 'paper' ? '纸张' : field === 'rubber' ? '拓工' : '钤印';
}

/* ------------------------------------------------------------------ */
/* 导出：待裁项清零后才允许更新导出包                                   */
/* ------------------------------------------------------------------ */

export function canExport(state: ReconState) {
  return pendingCount(state) === 0;
}

export function exportBlockReason(state: ReconState): string {
  const count = pendingCount(state);
  return count ? `仍有 ${count} 条待裁项未处理，暂不能更新导出包` : '';
}

export function buildExport(state: ReconState): ReconExport {
  const pending = pendingCount(state);
  if (pending) throw new Error(exportBlockReason(state));
  return {
    kind: 'rubbing-reconciliation-export',
    exportedAt: now(),
    revision: state.revision,
    records: state.records.map((record) => ({
      stableNo: record.stableNo,
      rubbingNo: record.rubbingNo,
      copyBatch: record.copyBatch,
      stone: record.stone,
      fingerprint: record.fingerprint,
      paper: record.paper,
      rubber: record.rubber,
      seals: record.seals,
      notes: record.notes,
      recordLocked: record.recordLocked,
      resolvedFields: DISPUTED_FIELDS.filter((field) => record.disputed[field].choice.resolution !== 'pending')
    })),
    adjudications: state.adjudications.map((item) => ({
      id: item.id,
      stableNo: item.stableNo,
      field: item.field,
      status: item.status,
      resolution: item.resolution,
      chosenValue: item.chosenValue,
      resolvedAt: item.resolvedAt
    })),
    receipts: state.receipts
  };
}

/* ------------------------------------------------------------------ */
/* 示例数据                                                            */
/* ------------------------------------------------------------------ */

export function seedReconState(): ReconState {
  const stamp = now();
  const records: RubbingRecord[] = [
    makeRecord({
      stableNo: 'STB-1824-0032', rubbingNo: '拓甲-0145', copyBatch: '道光四年摹刻批',
      stone: '《玄秘塔碑》原石（西安碑林）', fingerprint: 'sha256:9f2c41a7e8',
      paper: '白棉纸', rubber: '乌金拓', seals: [{ text: '端方之印', position: '右下' }, { text: '鉴赏', position: '引首' }],
      notes: '本机台账：道光四年摹刻批入库件'
    }),
    makeRecord({
      stableNo: 'STB-1790-0118', rubbingNo: '拓乙-0067', copyBatch: '乾隆五十五年补拓批',
      stone: '《曹全碑》原石', fingerprint: 'sha256:3bd819e0c2',
      paper: '连史纸', rubber: '蝉翼拓', seals: [{ text: '萑苇馆藏', position: '左下' }],
      notes: '本机编号曾由「拓-0067」改为「拓乙-0067」，稳定编号未动'
    }),
    makeRecord({
      stableNo: 'STB-1876-0205', rubbingNo: '拓丙-0210', copyBatch: '光绪二年重摹批',
      stone: '《张迁碑》翻刻石', fingerprint: 'sha256:77aa05d2f9',
      paper: '皮纸', rubber: '乌金拓', seals: [],
      notes: '已确认件，用于验证回传不覆盖',
      recordLocked: true
    })
  ];
  records.forEach((record) => {
    record.createdAt = stamp;
    record.updatedAt = stamp;
  });

  return {
    revision: 1,
    records,
    adjudications: [],
    receipts: [],
    audit: [{
      id: uid('aud'),
      at: stamp,
      action: '初始化拓片台账',
      detail: '导入本机碑帖拓片示例记录 3 条，等待外场版本比对包回传对账',
      recordIds: records.map((record) => record.id)
    }],
    hydrated: false
  };
}
