/* 运行 scripts/vite.smoke-build 产出的 SSR 包，校验渲染内容 */
const { renderSmoke } = await import('../dist-smoke/server/server.mjs');
const result = await renderSmoke();
const html = typeof result === 'string' ? result : (result.html ?? result.stream ?? '');

const checks = [
  '碑帖拓片版本比对台',
  '待裁项队列',
  '拓片台账',
  '九成宫醴泉铭',
  '多宝塔感应碑',
  '乌金拓',
  '蝉翼拓',
  '回传导入比对包',
  'data-dispute-id="TK-002:rubber"',
  '善本-甲-001'
];
let failed = 0;
for (const c of checks) {
  if (html.includes(c)) console.log('  ✓ SSR 输出含「' + c + '」');
  else { console.error('  ✗ 缺少「' + c + '」'); failed++; }
}
if (failed) process.exit(1);
console.log('\nSSR 渲染冒烟通过，输出', html.length, '字符');
