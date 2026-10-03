/**
 * 碑帖拓片回传对账领域模型
 *
 * 外场编目组（field cataloguing team）按「拓片号 / 摹刻批次 / 原石 / 扫描指纹」
 * 登记版本比对包（reconciliation packet），带回本机版本比对台做合并对账。
 */

/** 包格式版本：v1 为旧版字段命名，导入时迁移到 v2 */
export type PacketSchemaVersion = 1 | 2;

/** 三个允许分歧、需要并列保留的字段（纸张 / 拓工 / 钤印） */
export type DisputedField = 'paper' | 'rubber' | 'seals';

export type VariantOrigin = 'local' | 'incoming' | 'adjudicated';

/** 并列保留的候选值。同一来源的值重复登记时只保留一份。 */
export interface FieldVariant {
  value: string;
  origin: VariantOrigin;
  packetId?: string;
  receivedAt: string;
  /** 仅钤印字段：候选对应的结构化快照，裁决时可整体恢复印文与位置 */
  seals?: SealMark[];
}

/** 字段的裁决状态：未裁决时多值并列，不写回正式字段 */
export type FieldResolution = 'pending' | 'local' | 'incoming' | 'adjudicated';

export interface FieldChoice {
  resolution: FieldResolution;
  /** 裁决时选定的规范化文本 */
  chosenValue?: string;
  adjudicatedAt?: string;
  /** 选定值在 variants 中的位置，便于审计回放 */
  chosenVariantIndex?: number;
}

/** 外场包中的单条登记 */
export interface PacketEntry {
  stableNo: string;
  rubbingNo: string;
  copyBatch: string;
  stone: string;
  fingerprint: string;
  paper: string;
  rubber: string;
  /** v2 中钤印是结构化数组，每条含印文与位置 */
  seals: SealMark[];
  packetRev?: number;
}

export interface SealMark {
  text: string;
  position: string;
}

/** 版本比对包（v2 当前格式） */
export interface ReconPacket {
  packetId: string;
  schemaVersion: 2;
  exportedAt: string;
  source: string;
  entries: PacketEntry[];
}

/** 旧版包（v1）：字段名不同、钤印为自由文本、无指纹也允许 */
export interface LegacyPacketEntry {
  stable_id?: string;
  rubbing_id?: string;
  batch?: string;
  stele?: string;
  scan_hash?: string;
  paper_type?: string;
  artisan?: string;
  seals_text?: string;
}

export interface LegacyReconPacket {
  packetId?: string;
  id?: string;
  version?: number;
  schemaVersion?: number;
  exportedAt?: string;
  exported_at?: string;
  source?: string;
  team?: string;
  items?: LegacyPacketEntry[];
  entries?: LegacyPacketEntry[];
}

/** 本机记录上三个可分歧字段的并列与裁决状态 */
export type DisputedState = Record<DisputedField, {
  variants: FieldVariant[];
  choice: FieldChoice;
}>;

/** 本机拓片台账记录 */
export interface RubbingRecord {
  id: string;
  /** 稳定编号：跨包挂接的首选键，永不改动其语义 */
  stableNo: string;
  rubbingNo: string;
  copyBatch: string;
  stone: string;
  fingerprint: string;
  paper: string;
  rubber: string;
  seals: SealMark[];
  notes: string;
  createdAt: string;
  updatedAt: string;
  /** 整记录确认后，回传只追加候选，不覆盖任何字段 */
  recordLocked: boolean;
  disputed: DisputedState;
  /** 挂接历史：本机改号 / 指纹挂接的来龙去脉 */
  linkAliases: Array<{ stableNo: string; rubbingNo: string; fingerprint: string; packetId: string; at: string }>;
}

/** 待裁项状态机 */
export type AdjudicationStatus = 'pending' | 'resolved' | 'dismissed';

/** 分歧待裁项：纸张 / 拓工 / 钤印有分歧时生成一条 */
export interface AdjudicationItem {
  id: string;
  recordId: string;
  stableNo: string;
  field: DisputedField;
  packetId: string;
  status: AdjudicationStatus;
  createdAt: string;
  resolvedAt?: string;
  /** 快照：裁决界面在记录继续演进时仍能回放当时的候选 */
  variants: FieldVariant[];
  resolution?: FieldResolution;
  chosenValue?: string;
}

/** 导入回执：整包一条；中断后以 entriesProcessed 续跑，不重复建档 */
export interface ImportReceipt {
  packetId: string;
  schemaVersionImported: PacketSchemaVersion;
  startedAt: string;
  finishedAt?: string;
  source: string;
  totalEntries: number;
  entriesProcessed: number;
  linked: number;
  relinkedByFingerprint: number;
  created: number;
  conflictsRaised: number;
  /** 已处理条目的幂等键，重试时跳过 */
  processedKeys: string[];
}

export interface ReconAuditEntry {
  id: string;
  at: string;
  action: string;
  detail: string;
  recordIds: string[];
  packetId?: string;
}

/** 导出包（对账结论回写） */
export interface ReconExport {
  kind: 'rubbing-reconciliation-export';
  exportedAt: string;
  revision: number;
  records: Array<{
    stableNo: string;
    rubbingNo: string;
    copyBatch: string;
    stone: string;
    fingerprint: string;
    paper: string;
    rubber: string;
    seals: SealMark[];
    notes: string;
    recordLocked: boolean;
    resolvedFields: DisputedField[];
  }>;
  adjudications: Array<Pick<AdjudicationItem, 'id' | 'stableNo' | 'field' | 'status' | 'resolution' | 'chosenValue' | 'resolvedAt'>>;
  receipts: ImportReceipt[];
}

export interface ReconState {
  revision: number;
  records: RubbingRecord[];
  adjudications: AdjudicationItem[];
  receipts: ImportReceipt[];
  audit: ReconAuditEntry[];
  hydrated: boolean;
}
