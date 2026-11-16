import assert from 'node:assert/strict';
import test from 'node:test';

import {
  inlineMarkdown,
  markdownToHtml,
  renderHtml,
} from '../../../src/channels/shared/markdown-image.mjs';

test('table, list, quote, code block and inline marks become real HTML', () => {
  const html = markdownToHtml([
    '# 标题',
    '',
    '> 一句话结论，含 `code` 与 **粗体**。',
    '',
    '- 第一项 **重点**',
    '- 第二项',
    '  - 子项 A',
    '1. 有序一',
    '',
    '| 任务 | success | 判读 |',
    '|---|---|---|',
    '| jeans-issue-fixer | 2 | 正常 ✅ |',
    '',
    '```bash',
    'echo "<tag>"',
    '```',
  ].join('\n'));
  assert.match(html, /<h1>标题<\/h1>/u);
  assert.match(html, /<blockquote>.*<code>code<\/code>.*<strong>粗体<\/strong>.*<\/blockquote>/u);
  assert.match(html, /<li>第一项 <strong>重点<\/strong><\/li>/u);
  assert.equal((html.match(/<ul>/gu) || []).length, 2);
  assert.match(html, /<li>有序一<\/li>/u);
  assert.match(html, /<thead><tr><th>任务<\/th><th>success<\/th>/u);
  assert.match(html, /<td>2<\/td>/u);
  assert.match(html, /正常 ✅/u);
  assert.match(html, /<pre><code>echo &quot;&lt;tag&gt;&quot;/u);
  // 分隔行和列表符号都不许漏进正文
  assert.ok(!html.includes('|---|'), html);
  assert.ok(!html.includes('**'), html);
});

test('inline marks: links, italics, strike-through, images degrade to alt text', () => {
  assert.equal(inlineMarkdown('[官网](https://example.com)'),
    '<a href="https://example.com">官网</a>');
  assert.equal(inlineMarkdown('*斜体*'), '<em>斜体</em>');
  assert.equal(inlineMarkdown('~~删掉~~'), '<del>删掉</del>');
  assert.equal(inlineMarkdown('![img2]'), '![img2]');
  assert.equal(inlineMarkdown('![说明](https://x.test/a.png)'), '说明');
  // 双星不能被斜体规则吃掉
  assert.equal(inlineMarkdown('**粗**'), '<strong>粗</strong>');
});

test('titleFirst upgrades the first paragraph to a heading', () => {
  const html = markdownToHtml('审批请求\n\n工具：bash\n\n操作参数：\nid:\n    abc\n操作：批准',
    { titleFirst: true });
  assert.match(html, /<h1>审批请求<\/h1>/u);
  assert.match(html, /<p class="kv"><strong>id:<\/strong><\/p>/u);
  assert.match(html, /<p class="kv-value">abc<\/p>/u);
  assert.match(html, /<p>操作：批准<\/p>/u);
});

test('page HTML keeps the layout contract', () => {
  const html = renderHtml('# x', { width: 720, accent: '#b4534b' });
  assert.match(html, /width:720px/u);
  assert.match(html, /#b4534b/u);
  assert.match(html, /Noto Color Emoji/u);
  assert.match(html, /white-space:nowrap/u);
});

test('empty and plain input stay safe', () => {
  assert.equal(markdownToHtml(''), '');
  assert.equal(markdownToHtml('裸文本'), '<p>裸文本</p>');
  assert.equal(markdownToHtml('<script>alert(1)</script>'),
    '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
});
