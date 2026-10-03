// 碑帖拓片版本比对 · 回传对账核心逻辑
//
// 设计要点：
// 1. 稳定编号（拓片号 stableId）是唯一挂接依据；本机编号 localNo 改了也按 stableId / alias 挂回。
// 2. 纸张/拓工/钤印分歧时并列保留（variants），确认前不覆盖已确认结果（confirmed 字段受保护）。
// 3. 同一包按 packageId:itemNo 幂等，重试不重复建档；中断后凭已处理条目续传。
// 4. 旧版包（缺字段/版本号较低）做归一化迁移后导入。

import type {
  AppliedItem,
  ComparisonPackage,
  DeskState,
  Dispute,
  DisputeField,
  FieldState,
  PackageItem
} from '../types';
import { DISPUTE_FIELDS } from '../types';

let idCounter = 0;
export const uid = (prefix: string) => {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}-${Math.random().toString(36).slice(2, 8)}`;
};

export const now = () => new Date().toISOString();

const emptyField = (): FieldState => ({ variants: [], chosen: null, confirmed: false, confirmedAt: null });

const fieldOf = (item: PackageItem, field: DisputeField): string => {
  const raw = item[field];
  return typeof raw === 'string' ? raw.trim() : '';
};

/** 并列追加一个候选值：去重、保序；空值忽略。 */
const appendVariant = (field: FieldState, value: string): FieldState => {
  const valueTrim = value.trim();
  if (!valueTrim) return field;
  if (field.variants.includes(valueTrim)) return field;
  return { ...field, variants: [...field.variants, valueTrim] };
};

/**
 * 把任意可能的旧版包归一化为当前结构。
 * - v1：可能没有 packageVersion / scanFingerprint / notes，字段名为中文或 rubbingNo 缺失。
 * - 兼容顶层包裹 { package: {...} } 或裸数组条目。
 */
export const normalizePackage = (raw: unknown): ComparisonPackage => {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const source: Record<string, unknown> =
    'items' in obj ? obj : 'package' in obj ? (obj.package as Record<string, unknown>) : obj;

  const rawItems: unknown[] = Array.isArray(source.items)
    ? source.items
    : Array.isArray(obj)
      ? (obj as unknown[])
      : Array.isArray(source)
        ? (source as unknown[])
        : [];

  const packageVersion = typeof source.packageVersion === 'number' ? source.packageVersion : 1;
  const packageId = String(source.packageId ?? `legacy-${uid('pkg')}`);
  const exportedAt = typeof source.exportedAt === 'string' ? source.exportedAt : now();

  const items: PackageItem[] = rawItems.map((entry, index) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const pick = (...keys: string[]) => {
      for (const key of keys) {
        if (e[key] !== undefined && e[key] !== null) return String(e[key]);
      }
      return '';
    };
    return {
      itemNo: pick('itemNo', '序号', 'no') || String(index + 1).padStart(3, '0'),
      stableId: pick('stableId', '拓片号', 'rubbingId', 'id'),
      rubbingNo: pick('rubbingNo', '编号', 'no') || pick('stableId', '拓片号'),
      title: pick('title', '名称', '碑名'),
      batch: pick('batch', '摹刻批次', '批次'),
      originalStone: pick('originalStone', '原石', 'stone'),
      scanFingerprint: pick('scanFingerprint', '扫描指纹', 'fingerprint', '指纹'),
      paper: pick('paper', '纸张'),
      rubber: pick('rubber', '拓工'),
      seals: pick('seals', '钤印'),
      notes: pick('notes', '备注')
    };
  }).filter((item) => item.stableId);

  return { packageId, packageVersion, exportedAt, team: source.team as string | undefined, items };
};

const disputeId = (stableId: string, field: DisputeField) => `${stableId}:${field}`;

const ensureDispute = (
  disputes: Dispute[],
  stableId: string,
  field: DisputeField,
  variants: string[],
  itemNo: string,
  at: string
): { list: Dispute[]; created: boolean } => {
  const id = disputeId(stableId, field);
  const existing = disputes.find((item) => item.id === id);
  if (existing) {
    // 已存在待裁项：同步并列候选值；已确认（resolved）的不回退
    if (existing.status === 'resolved') return { list: disputes, created: false };
    const merged = Array.from(new Set([...existing.variants, ...variants]));
    const same = merged.length === existing.variants.length && merged.every((v, i) => v === existing.variants[i]);
    if (same) return { list: disputes, created: false };
    return {
      list: disputes.map((item) => (item.id === id ? { ...item, variants: merged } : item)),
      created: false
    };
  }
  const created: Dispute = {
    id,
    stableId,
    field,
    variants,
    status: 'pending',
    sourceItemNo: itemNo,
    createdAt: at,
    resolvedAt: null,
    resolution: null
  };
  return { list: [...disputes, created], created: true };
};

/**
 * 应用单条包条目（纯函数：输入状态副本，返回新记录/待裁项与结果）。
 * 调用方负责幂等判断与审计。
 */
export const applyPackageItem = (
  records: DeskState['records'],
  disputes: Dispute[],
  item: PackageItem,
  at: string
): { records: DeskState['records']; disputes: Dispute[]; result: AppliedItem } => {
  const result: AppliedItem = {
    stableId: item.stableId,
    itemNo: item.itemNo,
    created: false,
    changed: false,
    newDisputes: [],
    fingerprintMismatch: false,
    blockedFields: []
  };

  // —— 挂回原记录：只认稳定编号；本机改过编号也不错配 ——
  let record = records.find((entry) => entry.stableId === item.stableId)
    ?? records.find((entry) => entry.aliases.includes(item.rubbingNo) && item.rubbingNo.length > 0);

  if (!record) {
    // 新建档：稳定编号为准，包内编号作为本机编号与别名
    record = {
      stableId: item.stableId,
      localNo: item.rubbingNo || item.stableId,
      aliases: item.rubbingNo && item.rubbingNo !== item.stableId ? [item.rubbingNo] : [],
      title: item.title,
      batch: item.batch,
      originalStone: item.originalStone,
      scanFingerprint: item.scanFingerprint,
      paper: emptyField(),
      rubber: emptyField(),
      seals: emptyField(),
      notes: item.notes ?? '',
      createdAt: at,
      updatedAt: at,
      lastImportItemNo: item.itemNo
    };
    // 首次录入的字段值直接作为唯一并列候选（未确认）
    DISPUTE_FIELDS.forEach((field) => {
      const value = fieldOf(item, field);
      if (value) record![field] = appendVariant(record![field], value);
    });
    result.created = true;
    result.changed = true;
    return { records: [...records, record], disputes, result };
  }

  // —— 挂回已有记录 ——
  // 记录包内曾用编号（幂等去重）
  const aliases = item.rubbingNo && item.rubbingNo !== record.stableId && !record.aliases.includes(item.rubbingNo)
    ? [...record.aliases, item.rubbingNo]
    : record.aliases;

  if (item.scanFingerprint && record.scanFingerprint && item.scanFingerprint !== record.scanFingerprint) {
    result.fingerprintMismatch = true;
  }

  // 标题/批次/原石/指纹：包值补充空槽；非空且不同则并入备注，绝不静默覆盖本机值
  let notes = record.notes;
  const mergePlain = (current: string, incoming: string, label: string): string => {
    const value = incoming.trim();
    if (!value || value === current) return current;
    if (!current) { result.changed = true; return value; }
    const note = `【外场${label}】${value}`;
    if (!notes.includes(note)) { notes = notes ? `${notes}\n${note}` : note; result.changed = true; }
    return current;
  };
  const title = mergePlain(record.title, item.title, '名称');
  const batch = mergePlain(record.batch, item.batch, '摹刻批次');
  const originalStone = mergePlain(record.originalStone, item.originalStone, '原石');
  // 指纹只核对、不改写（扫描批次差异属正常，提示即可）
  const scanFingerprint = record.scanFingerprint || item.scanFingerprint;
  if (item.notes && item.notes !== record.notes && !record.notes.includes(item.notes)) {
    notes = notes ? `${notes}\n【外场备注】${item.notes}` : `【外场备注】${item.notes}`;
    result.changed = true;
  }

  // —— 纸张 / 拓工 / 钤印：并列保留，确认前不覆盖已确认结果 ——
  let workingDisputes = disputes;
  const fields = {} as Record<DisputeField, FieldState>;
  DISPUTE_FIELDS.forEach((field) => {
    const incoming = fieldOf(item, field);
    let current = { ...record![field], variants: [...record![field].variants] };

    // 已确认字段：任何与确认值不符的回传都不得覆盖或改动 chosen，
    // 即便该值作为落选候选仍留在档，也记入 blockedFields 供审计追溯。
    if (current.confirmed) {
      if (incoming && incoming !== current.chosen) result.blockedFields.push(field);
      fields[field] = current;
      return;
    }

    if (!incoming) { fields[field] = current; return; }
    const before = current.variants;
    current = appendVariant(current, incoming);
    fields[field] = current;

    if (current.variants.length !== before.length) result.changed = true;

    // 存在两个及以上不同来源值 => 待裁项
    if (current.variants.length >= 2) {
      const id = disputeId(record!.stableId, field);
      const existed = workingDisputes.some((d) => d.id === id);
      const ensured = ensureDispute(workingDisputes, record!.stableId, field, current.variants, item.itemNo, at);
      workingDisputes = ensured.list;
      if (!existed) result.newDisputes.push({ stableId: record!.stableId, field });
    }
  });

  if (aliases !== record.aliases) result.changed = true;

  const updated: typeof record = {
    ...record,
    aliases,
    title,
    batch,
    originalStone,
    scanFingerprint,
    paper: fields.paper,
    rubber: fields.rubber,
    seals: fields.seals,
    notes,
    updatedAt: result.changed ? at : record.updatedAt,
    lastImportItemNo: item.itemNo
  };

  return {
    records: records.map((entry) => (entry.stableId === record!.stableId ? updated : entry)),
    disputes: workingDisputes,
    result
  };
};

export interface ImportOutcome {
  records: DeskState['records'];
  disputes: Dispute[];
  importedItems: DeskState['importedItems'];
  batch: DeskState['importBatches'][number];
  results: AppliedItem[];
  skipped: number;
  /** 中断时为已处理的条目数；整包完成则为总条目数 */
  processedCount: number;
  interrupted: boolean;
}

/**
 * 回传导入（幂等、可续传）。
 * @param processedKeys 本次会话已处理的 key（用于模拟/处理写入中断后的续传）
 * @param failAfter 处理到第几条后模拟写入中断（不含该条），缺省为不中断
 */
export const importPackage = (
  state: Pick<DeskState, 'records' | 'disputes' | 'importedItems' | 'importBatches'>,
  pkg: ComparisonPackage,
  opts: { processedKeys?: string[]; failAfter?: number } = {}
): ImportOutcome => {
  const at = now();
  const results: AppliedItem[] = [];
  let records = state.records;
  let disputes = state.disputes;
  let importedItems = [...state.importedItems];
  let skipped = 0;
  let processedCount = 0;

  const sessionDone = new Set(opts.processedKeys ?? []);
  importedItems.forEach((entry) => { if (entry.packageId === pkg.packageId) sessionDone.add(entry.key); });

  let interrupted = false;

  for (const item of pkg.items) {
    const key = `${pkg.packageId}:${item.itemNo}`;
    processedCount += 1;

    // 重试同一包：已建档条目直接跳过，不重复建档
    if (sessionDone.has(key)) { skipped += 1; continue; }

    const applied = applyPackageItem(records, disputes, item, at);
    records = applied.records;
    disputes = applied.disputes;
    results.push(applied.result);
    importedItems.push({
      key,
      packageId: pkg.packageId,
      packageVersion: pkg.packageVersion,
      itemNo: item.itemNo,
      stableId: item.stableId,
      importedAt: at
    });
    sessionDone.add(key);

    // 模拟写入中断：进度（上面的条目）已落盘，调用方可凭 processedKeys 续传
    if (typeof opts.failAfter === 'number' && results.length >= opts.failAfter) {
      interrupted = true;
      break;
    }
  }

  const processedKeys = importedItems
    .filter((entry) => entry.packageId === pkg.packageId)
    .map((entry) => entry.key);
  const totalItems = pkg.items.length;
  const existingBatch = state.importBatches.find((b) => b.packageId === pkg.packageId);
  const batch: DeskState['importBatches'][number] = {
    packageId: pkg.packageId,
    packageVersion: pkg.packageVersion,
    receivedAt: existingBatch?.receivedAt ?? at,
    finishedAt: interrupted ? null : (existingBatch?.finishedAt ?? at),
    totalItems,
    processedKeys
  };

  return { records, disputes, importedItems, batch, results, skipped, processedCount, interrupted };
};

/** 用户在待裁项中作出选择：写回 chosen/confirmed，已确认结果即受保护。 */
export const resolveDispute = (
  record: DeskState['records'][number],
  field: DisputeField,
  chosen: string,
  at: string
): DeskState['records'][number] => {
  const current = record[field];
  const variants = current.variants.includes(chosen) ? current.variants : [...current.variants, chosen];
  return {
    ...record,
    [field]: { variants, chosen, confirmed: true, confirmedAt: at },
    updatedAt: at
  };
};

/** 本机改编号：只改 localNo，stableId 永不变，旧编号进 aliases。 */
export const renameLocalNo = (
  record: DeskState['records'][number],
  next: string,
  at: string
): DeskState['records'][number] => {
  const value = next.trim();
  if (!value || value === record.localNo) return record;
  const aliases = record.aliases.includes(record.localNo) ? record.aliases : [record.localNo, ...record.aliases];
  return { ...record, localNo: value, aliases, updatedAt: at };
};
