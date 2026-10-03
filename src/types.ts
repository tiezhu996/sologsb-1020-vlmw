// 碑帖拓片版本比对台 · 领域类型

/** 可并列保留、待裁定的字段：纸张、拓工、钤印 */
export type DisputeField = 'paper' | 'rubber' | 'seals';

export const DISPUTE_FIELDS: DisputeField[] = ['paper', 'rubber', 'seals'];

export const DISPUTE_LABELS: Record<DisputeField, string> = {
  paper: '纸张',
  rubber: '拓工',
  seals: '钤印'
};

/**
 * 一个字段的并列取值。
 * - variants：并列保留的来源值（去重，保序）
 * - chosen：已确认后采用的值；存在即视为“已确认”
 * - confirmed：是否已经人工确认（确认后不允许被回传覆盖）
 */
export interface FieldState {
  variants: string[];
  chosen: string | null;
  confirmed: boolean;
  confirmedAt: string | null;
}

/** 本机版本比对台保存的拓片记录 */
export interface RubbingRecord {
  /** 稳定编号（拓片号），跨包不变，用于挂回原记录 */
  stableId: string;
  /** 本机当前编号，可能被改过；不作为对账依据 */
  localNo: string;
  /** 已知的历史编号，含外场/摹刻批次曾用编号 */
  aliases: string[];
  title: string;
  /** 摹刻批次 */
  batch: string;
  /** 原石描述/原石号 */
  originalStone: string;
  /** 扫描指纹（像素/文件指纹），只做核对提示，不参与挂接 */
  scanFingerprint: string;
  paper: FieldState;
  rubber: FieldState;
  seals: FieldState;
  notes: string;
  createdAt: string;
  updatedAt: string;
  /** 最后一次成功挂接该记录的外场包条目号 */
  lastImportItemNo: string | null;
}

/** 字段分歧（待裁项） */
export interface Dispute {
  /** `stableId:field`，天然去重、可重试幂等 */
  id: string;
  stableId: string;
  field: DisputeField;
  /** 并列保留的全部候选值（含本机与包内来源） */
  variants: string[];
  status: 'pending' | 'resolved';
  sourceItemNo: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolution: string | null;
}

export interface AuditEntry {
  id: string;
  at: string;
  action: string;
  detail: string;
  stableIds: string[];
}

/** 已导入过的包条目（幂等 + 续传） */
export interface ImportedItem {
  /** `packageId:itemNo`，同一包重试时据此跳过，不重复建档 */
  key: string;
  packageId: string;
  packageVersion: number;
  itemNo: string;
  stableId: string;
  importedAt: string;
}

export interface ImportBatch {
  packageId: string;
  packageVersion: number;
  receivedAt: string;
  finishedAt: string | null;
  totalItems: number;
  processedKeys: string[];
}

/** 外场版本比对包里的一条拓片登记 */
export interface PackageItem {
  itemNo: string;
  stableId: string;
  rubbingNo: string;
  title: string;
  batch: string;
  originalStone: string;
  scanFingerprint: string;
  paper: string;
  rubber: string;
  seals: string;
  notes?: string;
}

/** 外场回传的版本比对包（当前版本 2，可识别更旧的版本） */
export interface ComparisonPackage {
  packageId: string;
  packageVersion: number;
  exportedAt: string;
  team?: string;
  items: PackageItem[];
}

/** 单条包条目应用到本机状态后的结果 */
export interface AppliedItem {
  stableId: string;
  itemNo: string;
  created: boolean;
  /** 本次是否真正发生变化（重复/完全一致时为 false，便于跳过） */
  changed: boolean;
  newDisputes: Array<{ stableId: string; field: DisputeField }>;
  fingerprintMismatch: boolean;
  /** 因字段已确认而被挡下、未覆盖的字段 */
  blockedFields: DisputeField[];
}

export interface DeskState {
  revision: number;
  records: RubbingRecord[];
  disputes: Dispute[];
  audit: AuditEntry[];
  importedItems: ImportedItem[];
  importBatches: ImportBatch[];
  hydrated: boolean;
}

/** 导出给外场的回执包 */
export interface ExportReceipt {
  kind: 'rubbing-version-receipt';
  receiptVersion: number;
  exportedAt: string;
  stateRevision: number;
  pendingDisputeCount: number;
  records: Array<{
    stableId: string;
    localNo: string;
    title: string;
    batch: string;
    originalStone: string;
    scanFingerprint: string;
    paper: FieldState;
    rubber: FieldState;
    seals: FieldState;
    notes: string;
    updatedAt: string;
  }>;
  resolvedDisputes: Array<Pick<Dispute, 'id' | 'stableId' | 'field' | 'resolution' | 'resolvedAt'>>;
  audit: AuditEntry[];
}
