/* 核心对账逻辑验证：node --import esbuild 直接跑 TS */
import assert from 'node:assert/strict';
import { seedState } from '../src/data/seed';
import { importPackage, normalizePackage, renameLocalNo, resolveDispute } from '../src/utils/reconcile';
import type { ComparisonPackage, DeskState, DisputeField } from '../src/types';
import { DISPUTE_FIELDS } from '../src/types';
import { readFileSync } from 'node:fs';

let pass = 0;
const ok = (name: string, cond: boolean) => { assert.ok(cond, name); console.log('  ✓', name); pass++; };

// 可变状态：每步直接改 state 对象的字段，模拟 useStore
const state = seedState() as DeskState;

const apply = (pkg: ComparisonPackage, opts: { processedKeys?: string[]; failAfter?: number } = {}) => {
  const out = importPackage(
    { records: state.records, disputes: state.disputes, importedItems: state.importedItems, importBatches: state.importBatches },
    pkg, opts
  );
  state.records = out.records;
  state.disputes = out.disputes;
  state.importedItems = out.importedItems;
  state.importBatches = [out.batch, ...state.importBatches.filter((b) => b.packageId !== pkg.packageId)];
  return out;
};

console.log('1) 初始台账');
ok('4 件拓片', state.records.length === 4);
ok('TK-002 拓工两说并列待裁', (() => {
  const d = state.disputes.find((x) => x.id === 'TK-002:rubber');
  return d?.status === 'pending' && d.variants.join('|') === '乌金拓|蝉翼拓';
})());
ok('TK-001 纸张已确认锁定', state.records.find((r) => r.stableId === 'TK-001')!.paper.confirmed === true);

console.log('2) 稳定编号挂回：本机改过编号也不错配');
const v2 = normalizePackage(JSON.parse(readFileSync('public/samples/waihui-bidui-v2.json', 'utf8')));
{
  const before = state.records.length;
  const out = apply(v2);
  const r1 = state.records.find((r) => r.stableId === 'TK-001')!;
  ok('包内旧编号 BJT-2019-001 挂回了 TK-001（而非新建档）', r1 && !out.results.find((x) => x.stableId === 'TK-001')?.created);
  ok('本机编号仍是善本-甲-001，未被包覆盖', r1.localNo === '善本-甲-001');
  const r2 = state.records.find((r) => r.stableId === 'TK-002')!;
  // item 006 与 002 是同一 stableId，第二次登记 rubbingNo 不同
  ok('同包两条同 stableId 只对应一件记录', state.records.filter((r) => r.stableId === 'TK-002').length === 1);
  ok('TK-002 别名含外场编号 BJT-2017-088', r2.aliases.includes('BJT-2017-088'));
  ok('新建档 2 件（TK-005/006）', out.results.filter((x) => x.created).length === 2);
  ok('台账总数 4 + 2 = 6', state.records.length === before + 2);
}

console.log('3) 分歧并列保留');
{
  const r1 = state.records.find((r) => r.stableId === 'TK-001')!;
  ok('钤印两说并列（本机 + 外场）', r1.seals.variants.join('|') === '“欧阳信本”朱文印|善化张氏鉴藏白文印');
  const d = state.disputes.find((x) => x.id === 'TK-001:seals');
  ok('生成 TK-001 钤印待裁项', d?.status === 'pending');
  const r3 = state.records.find((r) => r.stableId === 'TK-003')!;
  ok('TK-003 拓工两说并列', r3.rubber.variants.join('|') === '淡墨蝉翼拓|擦墨拓');
}

console.log('4) 确认前不覆盖已确认结果');
{
  const r1 = state.records.find((r) => r.stableId === 'TK-001')!;
  ok('TK-001 纸张仍为已确认值，未被外场“清中期竹纸”覆盖', r1.paper.chosen === '清乾隆仿藏经纸' && !r1.paper.variants.includes('清中期竹纸'));
  // 后续批次（另一个包号）再次回传冲突纸张：已确认纸张字段必须被挡下
  const reReport = (packageId: string): ComparisonPackage => ({
    packageId, packageVersion: 2, exportedAt: new Date().toISOString(), items: [
      { itemNo: '001', stableId: 'TK-001', rubbingNo: 'BJT-2019-001', title: '九成宫醴泉铭', batch: '北宋拓本摹刻·第三批', originalStone: '麟游', scanFingerprint: 'sha256:9c3a6f21e0b4', paper: '清中期竹纸', rubber: '浓墨乌金拓', seals: '善化张氏鉴藏白文印' }
    ]
  });
  const blocked = apply(reReport('WAIHUI-2026-10-C')).results.find((x) => x.stableId === 'TK-001');
  ok('再次回传：已确认纸张字段被记为 blockedFields', blocked?.blockedFields.includes('paper'));
  // 裁定钤印后，下一批次再回传，钤印也必须被保护
  const updated = resolveDispute(r1, 'seals', r1.seals.variants[0], new Date().toISOString());
  state.records = state.records.map((r) => r.stableId === 'TK-001' ? updated : r);
  state.disputes = state.disputes.map((d) => d.id === 'TK-001:seals' ? { ...d, status: 'resolved', resolvedAt: new Date().toISOString(), resolution: updated.seals.chosen } : d);
  const again = apply(reReport('WAIHUI-2026-10-D')).results.find((x) => x.stableId === 'TK-001');
  ok('裁定后重传：钤印进入 blockedFields，chosen 不变', again?.blockedFields.includes('seals') && state.records.find((r) => r.stableId === 'TK-001')!.seals.chosen === '“欧阳信本”朱文印');
}

console.log('5) 写入中断保留进度 + 重试不重复建档');
{
  // 用一个全新的包模拟首次导入到第 2 条中断
  const fresh: ComparisonPackage = {
    packageId: 'TEST-RESUME', packageVersion: 2, exportedAt: new Date().toISOString(), items: [
      { itemNo: '1', stableId: 'T-1', rubbingNo: 'T-1', title: '甲', batch: '', originalStone: '', scanFingerprint: 'f1', paper: '皮纸', rubber: '乌金拓', seals: '无' },
      { itemNo: '2', stableId: 'T-2', rubbingNo: 'T-2', title: '乙', batch: '', originalStone: '', scanFingerprint: 'f2', paper: '皮纸', rubber: '蝉翼拓', seals: '无' },
      { itemNo: '3', stableId: 'T-3', rubbingNo: 'T-3', title: '丙', batch: '', originalStone: '', scanFingerprint: 'f3', paper: '竹纸', rubber: '乌金拓', seals: '无' }
    ]
  };
  const before = state.records.length;
  const interrupted = apply(fresh, { failAfter: 2 });
  ok('第 2 条后中断', interrupted.interrupted === true);
  ok('中断时已建 2 件档', state.records.length === before + 2);
  const batch = state.importBatches.find((b) => b.packageId === 'TEST-RESUME')!;
  ok('批次 finishedAt 为空且已落盘 2 个 key', batch.finishedAt === null && batch.processedKeys.length === 2);

  // 整包重试（不带进度参数，importPackage 也会读取 state.importedItems 跳过）
  const retry = apply(fresh);
  ok('重试不重复建档（跳过 2 条，新建第 3 条）', retry.skipped === 2 && retry.results.length === 1 && retry.results[0].stableId === 'T-3');
  ok('台账新增恰好 3 件', state.records.length === before + 3);
  ok('重试后批次完成', state.importBatches.find((b) => b.packageId === 'TEST-RESUME')!.finishedAt !== null);

  // 第三次：全部幂等
  const again = apply(fresh);
  ok('完成后再导整包全部跳过、零结果', again.skipped === 3 && again.results.length === 0);
}

console.log('6) 旧版包（中文键 / 无版本号 / 无指纹）兼容导入');
{
  const legacy = normalizePackage(JSON.parse(readFileSync('public/samples/waihui-bidui-legacy-v1.json', 'utf8')));
  ok('识别为 v1', legacy.packageVersion === 1);
  ok('中文键映射到 stableId/title 等', legacy.items[1].stableId === 'TK-007' && legacy.items[1].title === '鲁相史晨奏祀孔子庙碑');
  const before = state.records.length;
  const out = apply(legacy);
  ok('旧版包新建 TK-007、挂回 TK-004', out.results.find((r) => r.stableId === 'TK-007')?.created && !out.results.find((r) => r.stableId === 'TK-004')?.created);
  ok('TK-004 钤印分歧并列（本机东郡张氏 vs 外场项元汴）', state.records.find((r) => r.stableId === 'TK-004')!.seals.variants.length === 2);
  ok('台账新增 1 件', state.records.length === before + 1);
}

console.log('7) 本机改编号不影响稳定挂接');
{
  const r = state.records.find((x) => x.stableId === 'TK-003')!;
  const updated = renameLocalNo(r, '善本-乙-003', new Date().toISOString());
  state.records = state.records.map((x) => x.stableId === 'TK-003' ? updated : x);
  const r3 = state.records.find((x) => x.stableId === 'TK-003')!;
  ok('本机编号已改', r3.localNo === '善本-乙-003');
  ok('旧号 TK-003 入别名、stableId 不变', r3.aliases.includes('TK-003') && r3.stableId === 'TK-003');
}

console.log('8) 待裁项处理完才允许导出（由 UI 门控；这里校验全部字段可清零）');
{
  // 把所有 pending 全部按首项裁定
  state.disputes.filter((d) => d.status === 'pending').forEach((d) => {
    const rec = state.records.find((r) => r.stableId === d.stableId)!;
    const u = resolveDispute(rec, d.field as DisputeField, d.variants[0], new Date().toISOString());
    state.records = state.records.map((r) => r.stableId === rec.stableId ? u : r);
    state.disputes = state.disputes.map((x) => x.id === d.id ? { ...x, status: 'resolved' as const, resolvedAt: new Date().toISOString(), resolution: d.variants[0] } : x);
  });
  ok('待裁项清零', state.disputes.every((d) => d.status === 'resolved'));
  ok('每件记录三个字段仍保留并列候选留档', state.records.every((r) => DISPUTE_FIELDS.every((f) => Array.isArray(r[f].variants))));
}

console.log(`\n全部通过：${pass} 项断言`);
