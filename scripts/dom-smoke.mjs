// 轻量 DOM 冒烟：用 linkedom 挂载生产入口，验证两个工作台都能渲染且无抛错
import { parseHTML } from 'linkedom';
import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';
import { resolve } from 'path';

const indexHtml = readFileSync('dist/index.html', 'utf-8');
const { window, document, customElements, HTMLElement, Node, MutationObserver, Event, CustomEvent, KeyboardEvent, getComputedStyle } = parseHTML(indexHtml);

globalThis.window = window;
globalThis.document = document;
globalThis.customElements = customElements;
globalThis.HTMLElement = HTMLElement;
globalThis.Node = Node;
globalThis.MutationObserver = MutationObserver;
globalThis.Event = Event;
globalThis.CustomEvent = CustomEvent;
globalThis.KeyboardEvent = KeyboardEvent;
globalThis.getComputedStyle = getComputedStyle;
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
if (!window.scrollTo) window.scrollTo = () => {};
const memoryStore = new Map();
const localStorageStub = {
  getItem: (key) => (memoryStore.has(key) ? memoryStore.get(key) : null),
  setItem: (key, value) => memoryStore.set(key, String(value)),
  removeItem: (key) => memoryStore.delete(key),
  clear: () => memoryStore.clear()
};
globalThis.localStorage = localStorageStub;
window.localStorage = localStorageStub;
if (!document.scrollingElement) document.scrollingElement = document.documentElement;
try { Object.defineProperty(document, 'baseURI', { value: 'http://localhost/', configurable: true }); } catch { /* 已有值则忽略 */ }
// linkedom 垫片：Qwik preloader 需要 link.relList、元素 dataset 等
const originalCreateElement = document.createElement.bind(document);
document.createElement = (tag) => {
  const element = originalCreateElement(tag);
  if (String(tag).toLowerCase() === 'link') {
    element.relList = { supports: () => true };
  }
  return element;
};

// qwikloader 扫描 inline module script；这里直接按生产入口加载
const entryMatch = indexHtml.match(/src="(\/assets\/[^"]+\.js)"/);
if (!entryMatch) throw new Error('未找到生产入口');
await new Promise((resolve) => setTimeout(resolve, 50));

// 入口在模块加载时即自行 render 到 #root
await import(pathToFileURL(resolve('dist' + entryMatch[1])).href);
await new Promise((resolvePromise) => setTimeout(resolvePromise, 600));

let html = document.getElementById('root').innerHTML;
const checks = [
  '碑帖拓片版本比对台',
  '外场版本比对包回传对账',
  '回传对账（导入比对包）',
  '更新导出包',
  'STB-1824-0032',
  '拓片版本比对台',
  '档案元数据核对台'
];
let ok = 0;
for (const text of checks) {
  if (html.includes(text)) { console.log('  ✓ 渲染包含：' + text); ok += 1; }
  else console.log('  ✗ 缺少：' + text);
}
console.log(`\nDOM 渲染冒烟：${ok}/${checks.length}`);
process.exit(ok === checks.length ? 0 : 1);
