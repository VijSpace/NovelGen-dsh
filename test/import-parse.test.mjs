// 验证 web/app.js 里的导入解析器(CSV/TSV/TXT)——从源文件提取纯函数在 node 中测试
import fs from 'node:fs';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf-8');
const start = src.indexOf('function parseDelimited');
const end = src.indexOf('function loadSheetJS');
assert.ok(start > 0 && end > start, '解析器区块定位失败');
const block = src.slice(start, end);

// eval 提取三个纯函数(无浏览器 API 依赖)
const fns = {};
eval(`(function(){ ${block}; fns.parseDelimited = parseDelimited; fns.rowsToItems = rowsToItems; fns.parseTxt = parseTxt; })()`);

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

console.log('== 导入解析器测试 ==');

test('CSV 带表头(卷,章,正文)', () => {
  const rows = fns.parseDelimited('卷,章,正文\n第一卷,第一章,你好世界\n第一卷,第二章,"含有,逗号的正文"');
  const items = fns.rowsToItems(rows);
  assert.equal(items.length, 2);
  assert.equal(items[0].volume, '第一卷');
  assert.equal(items[0].chapter, '第一章');
  assert.equal(items[0].content, '你好世界');
  assert.equal(items[1].content, '含有,逗号的正文'); // 引号内逗号不分割
});

test('CSV 无表头(首行就是数据,不应丢失)', () => {
  const rows = fns.parseDelimited('第一卷,第一章,正文一\n第一卷,第二章,正文二');
  const items = fns.rowsToItems(rows);
  assert.equal(items.length, 2);
  assert.equal(items[0].chapter, '第一章');
});

test('TSV 制表符分隔', () => {
  const rows = fns.parseDelimited('卷\t章\t正文\n甲\t一\t内容');
  const items = fns.rowsToItems(rows);
  assert.equal(items.length, 1);
  assert.equal(items[0].volume, '甲');
});

test('TXT markdown 风格(# 卷 / ## 章)', () => {
  const items = fns.parseTxt('# 第一卷\n## 第一章\n第一行。\n第二行。\n## 第二章\n后续。\n# 第二卷\n## 第三章\n终章。');
  assert.equal(items.length, 3);
  assert.equal(items[0].volume, '第一卷');
  assert.equal(items[0].chapter, '第一章');
  assert.equal(items[0].content, '第一行。\n第二行。');
  assert.equal(items[1].chapter, '第二章');
  assert.equal(items[2].volume, '第二卷');
});

test('TXT 无标题结构(整体一篇文章)', () => {
  const items = fns.parseTxt('随便一段文字。\n没有标题。');
  assert.equal(items.length, 1);
  assert.equal(items[0].content, '随便一段文字。\n没有标题。');
});

console.log(`\n共 ${passed} 项通过`);
