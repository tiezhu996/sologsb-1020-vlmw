import type { DeskState, Dispute, FieldState, RubbingRecord } from '../types';
import { now } from '../utils/reconcile';

const field = (variants: string[], chosen: string | null = null): FieldState => ({
  variants,
  chosen,
  confirmed: chosen !== null,
  confirmedAt: chosen !== null ? now() : null
});

const makeRecord = (partial: Partial<RubbingRecord> & Pick<RubbingRecord, 'stableId' | 'localNo' | 'title' | 'batch' | 'originalStone' | 'scanFingerprint'>): RubbingRecord => ({
  aliases: [],
  paper: field([]),
  rubber: field([]),
  seals: field([]),
  notes: '',
  createdAt: now(),
  updatedAt: now(),
  lastImportItemNo: null,
  ...partial
});

export const seedRecords = (): RubbingRecord[] => [
  makeRecord({
    stableId: 'TK-001',
    // 本机改过编号：旧编号在外场包里仍会出现，靠稳定编号与别名挂回
    localNo: '善本-甲-001',
    aliases: ['BJT-2019-001'],
    title: '九成宫醴泉铭',
    batch: '北宋拓本摹刻·第三批',
    originalStone: '麟游县九成宫故址（石存麟游）',
    scanFingerprint: 'sha256:9c3a6f21e0b4',
    paper: field(['清乾隆仿藏经纸'], '清乾隆仿藏经纸'),
    rubber: field(['浓墨乌金拓']),
    seals: field(['“欧阳信本”朱文印']),
    notes: '馆藏一级，纸背有旧签。'
  }),
  makeRecord({
    stableId: 'TK-002',
    localNo: 'TK-002',
    title: '多宝塔感应碑',
    batch: '明中期摹刻·首批',
    originalStone: '西安碑林第一室',
    scanFingerprint: 'sha256:41be77d89a10',
    paper: field(['棉连纸']),
    // 拓工两说并存，等待裁定
    rubber: field(['乌金拓', '蝉翼拓']),
    seals: field(['“颜氏家藏”半印'])
  }),
  makeRecord({
    stableId: 'TK-003',
    localNo: 'TK-003',
    title: '郃阳令曹全碑',
    batch: '明末摹刻·第二批',
    originalStone: '西安碑林第三室',
    scanFingerprint: 'sha256:77e02cc31af5',
    paper: field(['白棉纸']),
    rubber: field(['淡墨蝉翼拓']),
    seals: field(['未发现钤印'])
  }),
  makeRecord({
    stableId: 'TK-004',
    localNo: 'TK-004',
    title: '汉故谷城长荡阴令张君表颂（张迁碑）',
    batch: '清乾隆摹刻·第二批',
    originalStone: '山东泰安岱庙',
    scanFingerprint: 'sha256:5d91b4062c88',
    paper: field(['皮纸']),
    rubber: field(['乌金拓']),
    seals: field(['“东郡张氏”白文印'])
  })
];

export const seedState = (): DeskState => {
  const records = seedRecords();
  const disputes: Dispute[] = [];
  records.forEach((record) => {
    (['paper', 'rubber', 'seals'] as const).forEach((key) => {
      const state = record[key];
      if (!state.confirmed && state.variants.length >= 2) {
        disputes.push({
          id: `${record.stableId}:${key}`,
          stableId: record.stableId,
          field: key,
          variants: [...state.variants],
          status: 'pending',
          sourceItemNo: null,
          createdAt: now(),
          resolvedAt: null,
          resolution: null
        });
      }
    });
  });

  return {
    revision: 1,
    records,
    disputes,
    audit: [{
      id: 'seed',
      at: now(),
      action: '初始化本机台账',
      detail: '载入四件碑帖拓片本机记录，其中《多宝塔感应碑》拓工一项已有两说待裁',
      stableIds: records.map((record) => record.stableId)
    }],
    importedItems: [],
    importBatches: [],
    hydrated: false
  };
};
