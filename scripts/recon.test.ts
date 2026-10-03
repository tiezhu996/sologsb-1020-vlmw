import assert from 'node:assert/strict';
import {
  seedReconState, importPacket, adjudicateItem, toggleRecordLock,
  buildExport, canExport, sealsToText
} from '../src/recon/engine';
import { sampleV2Packet, sampleFingerprintOnlyPacket, sampleLegacyV1Packet } from '../src/recon/samplePackets';
import type { ReconState } from '../src/recon/types';

let pass = 0;
const ok = (cond: unknown, msg: string) => { assert(cond, `FAIL: ${msg}`); console.log(`  ✓ ${msg}`); pass += 1; };
const findByStable = (state: ReconState, stableNo: string) => state.records.find((r) => r.stableNo === stableNo)!;

/* ---- 1. 首次导入 v2 ---- */
const state = seedReconState();
const s1 = importPacket(state, JSON.stringify(sampleV2Packet()));
ok(s1.created === 1, `新建 1 条（实际 ${s1.created}）`);
ok(s1.linked === 3, `挂回 3 条（实际 ${s1.linked}）`);
ok(s1.finished === true, '整包入账完成');
ok(state.records.length === 4, '台账共 4 条（不重复）');

/* ---- 2. 稳定编号挂回 + 本机改号不错配 ---- */
const cao = findByStable(state, 'STB-1790-0118');
ok(cao.rubbingNo === '拓乙-0067', '本机改过的拓片号保持不变，没有被包里旧号「拓-0067」覆盖');

/* ---- 3. 纸张/钤印分歧并列，确认前不覆盖 ---- */
const xuanmi = findByStable(state, 'STB-1824-0032');
ok(xuanmi.paper === '白棉纸', '正式纸张仍为本机「白棉纸」，未被回传「宣纸」覆盖');
const paperVariants = xuanmi.disputed.paper.variants.map((v) => v.value);
ok(paperVariants.includes('白棉纸') && paperVariants.includes('宣纸'), `纸张两说并列：${paperVariants.join(' / ')}`);
ok(xuanmi.disputed.paper.choice.resolution === 'pending', '纸张字段处于待裁');
ok(xuanmi.seals.length === 2, '正式钤印仍是 2 枚，未被回传 3 枚覆盖');
ok(xuanmi.disputed.seals.variants.length === 2, '钤印本机/回传两说并列');

/* ---- 4. 已确认（锁定）记录：回传只追加候选，不覆盖 ---- */
const zhangqian = findByStable(state, 'STB-1876-0205');
ok(zhangqian.recordLocked === true, '种子记录为已确认');
ok(zhangqian.rubber === '乌金拓', '已确认记录的拓工未被回传「擦墨拓」覆盖');
ok(zhangqian.disputed.rubber.variants.some((v) => v.value === '擦墨拓'), '回传拓工作为候选并列保留');

/* ---- 5. 幂等：重试同一包不重复建档、不重复开单 ---- */
const adjCountBefore = state.adjudications.length;
const s2 = importPacket(state, JSON.stringify(sampleV2Packet()));
ok(s2.skippedAlreadyDone === 4, `4 条全部幂等跳过（实际 ${s2.skippedAlreadyDone}）`);
ok(s2.processedNow === 0, '本次无新增处理');
ok(state.records.length === 4, '重试后仍为 4 条，未重复建档');
ok(state.adjudications.length === adjCountBefore, '待裁项未重复开单');
ok(state.receipts.length === 1, '同一包只有一份回执');

/* ---- 6. 指纹兜底挂回（无稳定编号、拓片号不同）---- */
const s3 = importPacket(state, JSON.stringify(sampleFingerprintOnlyPacket()));
ok(s3.relinkedByFingerprint === 1, `指纹兜底挂回 1 条（实际 ${s3.relinkedByFingerprint}）`);
ok(state.records.length === 4, '指纹包没有新建记录');
ok(cao.linkAliases.length === 1, '改号记录登记了指纹挂接别名');
ok(cao.disputed.seals.variants.some((v) => v.value.includes('于右任')), '指纹包钤印差异进入并列候选');

/* ---- 7. 旧版 v1 包迁移导入 ---- */
const s4 = importPacket(state, sampleLegacyV1Packet());
ok(s4.migrated === true, 'v1 旧版包被识别并迁移');
ok(s4.linked === 1 && s4.created === 1, `旧包挂回 1、新建 1（实际 ${s4.linked}/${s4.created}）`);
const yiying = findByStable(state, 'STB-2011-0509');
ok(yiying.stone === '《乙瑛碑》原石', '旧包 stele→stone 迁移');
ok(yiying.rubber === '浓墨拓' && yiying.paper === '宣纸', '旧包 paper_type/artisan 字段迁移');
ok(yiying.seals.length === 1 && yiying.seals[0].position === '左上', '自由文本钤印拆成结构化印文+位置');

/* ---- 8. 导出闸门：有待裁项时禁止导出 ---- */
ok(canExport(state) === false, `存在待裁项（${state.adjudications.filter((a) => a.status === 'pending').length} 条），导出被拦截`);
assert.throws(() => buildExport(state), /待裁项/, 'buildExport 在有未决待裁项时抛错');
console.log('  ✓ buildExport 在有未决待裁项时抛错'); pass += 1;

/* ---- 9. 处理完全部待裁项后可导出；裁决写回正式字段 ---- */
const pending = state.adjudications.filter((a) => a.status === 'pending');
ok(pending.length >= 3, `待裁项数量合理（${pending.length}）`);
const paperAdj = state.adjudications.find((a) => a.recordId === xuanmi.id && a.field === 'paper' && a.status === 'pending')!;
adjudicateItem(state, paperAdj.id, 'incoming');
ok(xuanmi.paper === '宣纸', '裁决后正式纸张写回为「宣纸」');
const sealsAdj = state.adjudications.find((a) => a.recordId === xuanmi.id && a.field === 'seals' && a.status === 'pending')!;
adjudicateItem(state, sealsAdj.id, 'incoming');
ok(xuanmi.seals.length === 3, `钤印裁决后恢复为 3 枚（实际 ${xuanmi.seals.length}）：${sealsToText(xuanmi.seals)}`);
ok(!!xuanmi.seals.find((s) => s.text === '三秦观察使' && s.position === '骑缝'), '第 3 枚印文与位置完整恢复');
for (const item of state.adjudications.filter((a) => a.status === 'pending')) {
  adjudicateItem(state, item.id, 'local');
}
ok(zhangqian.rubber === '乌金拓', '已确认记录裁决保留本机拓工');
ok(canExport(state) === true, '待裁清零后允许导出');
const exported = buildExport(state);
ok(exported.records.length === 5, `导出包含 5 条台账（实际 ${exported.records.length}）`);
ok(exported.receipts.length === 3, `导出附带 3 份回执（实际 ${exported.receipts.length}）`);

/* ---- 10. 中断续跑：前 2 条入账后崩溃，进度已保留，再投全包从断点继续 ---- */
{
  const state2 = seedReconState();
  const full = sampleV2Packet();
  const partial = { ...full, entries: full.entries.slice(0, 2) };
  const first = importPacket(state2, JSON.stringify(partial));
  // 模拟真实中断：文件里有 4 条，但只写了 2 条进度
  const receipt = state2.receipts[0]!;
  receipt.totalEntries = 4;
  receipt.finishedAt = undefined;
  ok(first.processedNow === 2, '中断现场：只处理了前 2 条');
  const beforeCount = state2.records.length;
  const resumed = importPacket(state2, JSON.stringify(full));
  ok(resumed.resumed === true, '识别为中断包并续跑');
  ok(resumed.skippedAlreadyDone === 2 && resumed.processedNow === 2,
    `续跑跳过 2、补处理 2（实际 ${resumed.skippedAlreadyDone}/${resumed.processedNow}）`);
  ok(state2.records.length === beforeCount + 1, '续跑只新建缺的 1 条，前 2 条未重复建档');
  ok(!!receipt.finishedAt, '续跑后回执标记完成');
  // 续跑完成后再投一次整包，全部跳过
  const retry = importPacket(state2, JSON.stringify(full));
  ok(retry.skippedAlreadyDone === 4 && retry.processedNow === 0, '完成后再投整包：4 条全部幂等跳过');
}

/* ---- 11. 新包对已裁决字段再次产生分歧：不覆盖已定结果，重新挂起 ---- */
{
  const state3 = seedReconState();
  importPacket(state3, JSON.stringify(sampleV2Packet()));
  const adj = state3.adjudications.find((a) => {
    const r = state3.records.find((x) => x.id === a.recordId);
    return r?.stableNo === 'STB-1824-0032' && a.field === 'paper' && a.status === 'pending';
  })!;
  adjudicateItem(state3, adj.id, 'incoming'); // 定为「宣纸」
  const thirdPacket = {
    packetId: 'PK-2026-1003-NEW', schemaVersion: 2 as const, exportedAt: '2026-10-03T00:00:00Z', source: '外场编目组（复检）',
    entries: [{ stableNo: 'STB-1824-0032', rubbingNo: '拓甲-0145', copyBatch: '道光四年摹刻批', stone: '《玄秘塔碑》原石（西安碑林）', fingerprint: 'sha256:9f2c41a7e8', paper: '竹纸', rubber: '乌金拓', seals: [] }]
  };
  importPacket(state3, JSON.stringify(thirdPacket));
  const xm3 = state3.records.find((r) => r.stableNo === 'STB-1824-0032')!;
  ok(xm3.paper === '宣纸', '已裁决为「宣纸」后，新回传「竹纸」没有覆盖正式值');
  ok(xm3.disputed.paper.variants.some((v) => v.value === '竹纸'), '新说法「竹纸」作为第三候选并列保留');
  ok(xm3.disputed.paper.choice.resolution === 'pending', '字段重新挂起等待裁决');

  /* ---- 12. 锁定/解锁动作可逆 ---- */
  const before = xm3.recordLocked;
  toggleRecordLock(state3, xm3.id);
  ok(xm3.recordLocked === !before, '确认状态可切换');
}

/* ---- 13. 手工裁定自定义值 / 空值拒绝 ---- */
{
  const state4 = seedReconState();
  importPacket(state4, JSON.stringify(sampleV2Packet()));
  const r = state4.records.find((x) => x.stableNo === 'STB-1824-0032')!;
  const paperItem = state4.adjudications.find((a) => a.recordId === r.id && a.field === 'paper' && a.status === 'pending')!;
  assert.throws(() => adjudicateItem(state4, paperItem.id, 'adjudicated', '   '), /为空/, '空裁定被拒绝');
  console.log('  ✓ 空裁定内容被拒绝'); pass += 1;
  adjudicateItem(state4, paperItem.id, 'adjudicated', '白棉纸（外层加覆宣纸）');
  ok(r.paper === '白棉纸（外层加覆宣纸）', '手工裁定文本写入正式字段');
  ok(r.disputed.paper.variants.some((v) => v.origin === 'adjudicated'), '裁定值作为候选留痕');
}

console.log(`\n全部 ${pass} 项断言通过`);
