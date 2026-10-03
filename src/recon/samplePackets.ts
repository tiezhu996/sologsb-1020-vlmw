import type { ReconPacket } from './types';

/**
 * 示例回传包，用于演示与自测：
 * 1) sampleV2Packet —— 正常 v2 包：含稳定编号直挂、本机改号后指纹兜底、已确认件不覆盖、三处分歧；
 * 2) sampleV2Packet —— 同一包重复内容也可重试，验证幂等；
 * 3) sampleLegacyV1Packet —— 旧版 v1 包，字段名不同、钤印为自由文本。
 */

export const sampleV2Packet = (): ReconPacket => ({
  packetId: 'PK-2026-0928-FIELD',
  schemaVersion: 2,
  exportedAt: '2026-09-28T09:30:00.000Z',
  source: '外场编目组（碑林一组）',
  entries: [
    {
      // 稳定编号直挂；纸张、钤印有分歧
      stableNo: 'STB-1824-0032',
      rubbingNo: '拓甲-0145',
      copyBatch: '道光四年摹刻批',
      stone: '《玄秘塔碑》原石（西安碑林）',
      fingerprint: 'sha256:9f2c41a7e8',
      paper: '宣纸',
      rubber: '乌金拓',
      seals: [
        { text: '端方之印', position: '右下' },
        { text: '鉴赏', position: '引首' },
        { text: '三秦观察使', position: '骑缝' }
      ]
    },
    {
      // 本机已把拓片号改为「拓乙-0067」，包中沿用旧号；
      // 稳定编号可挂回；同时验证指纹兜底链路
      stableNo: 'STB-1790-0118',
      rubbingNo: '拓-0067',
      copyBatch: '乾隆五十五年补拓批',
      stone: '《曹全碑》原石',
      fingerprint: 'sha256:3bd819e0c2',
      paper: '连史纸',
      rubber: '扑拓',
      seals: [{ text: '萑苇馆藏', position: '左下' }]
    },
    {
      // 已确认（锁定）记录：拓工说法不同，只并列候选，不覆盖正式值
      stableNo: 'STB-1876-0205',
      rubbingNo: '拓丙-0210',
      copyBatch: '光绪二年重摹批',
      stone: '《张迁碑》翻刻石',
      fingerprint: 'sha256:77aa05d2f9',
      paper: '皮纸',
      rubber: '擦墨拓',
      seals: []
    },
    {
      // 全新拓片：建档
      stableNo: 'STB-1901-0331',
      rubbingNo: '拓丁-0302',
      copyBatch: '光绪二十七年补拓批',
      stone: '《颜勤礼碑》原石',
      fingerprint: 'sha256:c4e91b08ab',
      paper: '毛边纸',
      rubber: '乌金拓',
      seals: [{ text: '关中于氏', position: '右上角' }]
    }
  ]
});

/** 仅有指纹线索、没有稳定编号的包：用于演示指纹兜底挂回本机改号记录 */
export const sampleFingerprintOnlyPacket = (): ReconPacket => ({
  packetId: 'PK-2026-1001-FP',
  schemaVersion: 2,
  exportedAt: '2026-10-01T14:10:00.000Z',
  source: '外场编目组（扫描车）',
  entries: [
    {
      stableNo: '',
      rubbingNo: '外勤临时编号-X9',
      copyBatch: '乾隆五十五年补拓批',
      stone: '《曹全碑》原石',
      fingerprint: 'sha256:3bd819e0c2',
      paper: '连史纸',
      rubber: '蝉翼拓',
      seals: [{ text: '萑苇馆藏', position: '左下' }, { text: '于右任', position: '页首' }]
    }
  ]
});

/** 旧版 v1 包：snake_case 字段、钤印自由文本、无扫描指纹 */
export const sampleLegacyV1Packet = () => JSON.stringify({
  packetId: 'PK-OLD-2023-117',
  version: 1,
  exported_at: '2023-11-02T03:00:00.000Z',
  team: '外场编目组（历史批次补录）',
  items: [
    {
      stable_id: 'STB-1824-0032',
      rubbing_id: '拓甲-0145',
      batch: '道光四年摹刻批',
      stele: '《玄秘塔碑》原石（西安碑林）',
      paper_type: '白棉纸',
      artisan: '乌金拓',
      seals_text: '端方之印（右下）；鉴赏（引首）'
    },
    {
      stable_id: 'STB-2011-0509',
      rubbing_id: '旧拓-509',
      batch: '宣统三年拓批',
      stele: '《乙瑛碑》原石',
      scan_hash: '',
      paper_type: '宣纸',
      artisan: '浓墨拓',
      seals_text: '故宫博物院藏（左上）'
    }
  ]
});
