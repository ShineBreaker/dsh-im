/**
 * Markdown → 竖长图：HTML 排版 + headless chromium 截图 + 分段裁切。
 *
 * 与旧的等宽 SVG 渲染（sharp/libvips + pango）的区别：
 * 表格、列表、引用、代码块都按真实结构排版，不再是把 markdown 标记剥光的
 * 纯文本；彩色 emoji 也能正常出图（pango 只画得出黑白轮廓）。
 *
 * 渲染不是必需路径：sharp 缺失、找不到 chromium、截图失败一律返回空数组，
 * 调用方回退到发文本。
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULTS = Object.freeze({
  width: 760,
  paddingX: 36,
  paddingY: 32,
  fontSize: 21,
  maxHeight: 5_000,
  maxImages: 3,
  // chromium 画布高度上限：再高 headless 会挂，内容超了就明确失败而不是静默截断
  canvasHeight: 60_000,
  accent: '#4a6d8c',
  background: '#ffffff',
});

const FONT_STACK = '"Sarasa Gothic SC","Noto Sans CJK SC","Source Han Sans SC",'
  + '"Noto Color Emoji",sans-serif';
const MONO_STACK = '"Sarasa Mono CL","Sarasa Mono SC","Noto Sans Mono CJK SC",'
  + '"Source Han Mono SC",monospace';

const HEADING_LINE = /^(#{1,6})\s+(.*)$/u;
const BULLET_LINE = /^[-*+]\s+(.+)$/u;
const NUMBERED_LINE = /^\d+[.)]\s+(.+)$/u;
const RULE_LINE = /^(?:-{3,}|\*{3,}|_{3,})$/u;
const TABLE_SEP_LINE = /^\|?[\s:|-]+\|?$/u;
/** 参数键行：`id:`、`cross_workspace:` 这类，卡片里渲染成加粗强调色。 */
const KEY_LINE = /^[A-Za-z_][\w.-]*:$/u;

let sharpPromise;
function loadSharp() {
  sharpPromise ??= import('sharp').then((module) => module.default).catch(() => null);
  return sharpPromise;
}

// ---------- markdown -> html ----------

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** 行内标记 -> HTML。链接先于其余规则，粗体先于斜体。 */
export function inlineMarkdown(text) {
  let s = escapeHtml(text);
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/gu, '<a href="$2">$1</a>');
  s = s.replace(/`([^`]+)`/gu, '<code>$1</code>');
  s = s.replace(/\*\*(.+?)\*\*/gsu, '<strong>$1</strong>');
  s = s.replace(/(?<![*\w])\*(?!\*)([^*\n]+)\*(?![*\w])/gu, '<em>$1</em>');
  s = s.replace(/~~(.+?)~~/gsu, '<del>$1</del>');
  return s;
}

function tableCells(line) {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|')) row = row.slice(0, -1);
  return row.split('|').map((cell) => cell.trim());
}

function renderList(items, ordered) {
  const tag = ordered ? 'ol' : 'ul';
  const parts = [];
  let openSub = false;
  for (const [indent, text] of items) {
    if (indent > 0) {
      if (!openSub) {
        parts.push(`<${tag}>`);
        openSub = true;
      }
      parts.push(`<li>${inlineMarkdown(text)}</li>`);
    } else {
      if (openSub) {
        parts.push(`</${tag}>`);
        openSub = false;
      }
      parts.push(`<li>${inlineMarkdown(text)}</li>`);
    }
  }
  if (openSub) parts.push(`</${tag}>`);
  return `<${tag}>${parts.join('')}</${tag}>`;
}

function startsBlock(stripped) {
  return stripped.startsWith('```') || stripped.startsWith('|')
    || stripped.startsWith('>') || HEADING_LINE.test(stripped)
    || BULLET_LINE.test(stripped) || NUMBERED_LINE.test(stripped)
    || RULE_LINE.test(stripped) || KEY_LINE.test(stripped);
}

/** 块级 markdown -> HTML 片段。titleFirst 把首个非空行当 h1。 */
export function markdownToHtml(text, { titleFirst = false } = {}) {
  const lines = String(text).replace(/\r\n?/gu, '\n').split('\n');
  const out = [];
  let index = 0;
  let sawContent = false;
  const total = lines.length;

  while (index < total) {
    const raw = lines[index];
    const stripped = raw.trim();
    if (stripped === '') {
      index += 1;
      continue;
    }
    if (stripped.startsWith('```')) {
      index += 1;
      const body = [];
      while (index < total && !lines[index].trim().startsWith('```')) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      sawContent = true;
      continue;
    }
    if (stripped.startsWith('|') && index + 1 < total
      && TABLE_SEP_LINE.test(lines[index + 1].trim())
      && lines[index + 1].includes('-')) {
      const header = tableCells(stripped);
      index += 2;
      const rows = [];
      while (index < total && lines[index].trim().startsWith('|')) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      const head = header.map((c) => `<th>${inlineMarkdown(c)}</th>`).join('');
      const body = rows.map((row) => `<tr>${
        row.map((c) => `<td>${inlineMarkdown(c)}</td>`).join('')}</tr>`).join('');
      out.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
      sawContent = true;
      continue;
    }
    const heading = HEADING_LINE.exec(stripped);
    if (heading) {
      const level = Math.min(heading[1].length, 3);
      out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      sawContent = true;
      continue;
    }
    if (RULE_LINE.test(stripped)) {
      out.push('<hr>');
      index += 1;
      sawContent = true;
      continue;
    }
    if (BULLET_LINE.test(stripped) || NUMBERED_LINE.test(stripped)) {
      const ordered = NUMBERED_LINE.test(stripped);
      const pattern = ordered ? NUMBERED_LINE : BULLET_LINE;
      const items = [];
      while (index < total) {
        const row = lines[index];
        const matched = pattern.exec(row.trim());
        if (!matched) break;
        items.push([row.length - row.trimStart().length, matched[1]]);
        index += 1;
      }
      out.push(renderList(items, ordered));
      sawContent = true;
      continue;
    }
    if (stripped.startsWith('>')) {
      const quoted = [];
      while (index < total && lines[index].trim().startsWith('>')) {
        quoted.push(lines[index].trim().replace(/^>+/u, '').trim());
        index += 1;
      }
      out.push(`<blockquote>${quoted.map(inlineMarkdown).join('<br>')}</blockquote>`);
      sawContent = true;
      continue;
    }
    if (KEY_LINE.test(stripped)) {
      // 卡片参数块：键一行，值缩进挂在下面，多行值都归这个键
      const key = inlineMarkdown(stripped);
      index += 1;
      const values = [];
      while (index < total && /^\s{2,}\S/u.test(lines[index])) {
        values.push(lines[index].trim());
        index += 1;
      }
      out.push(`<p class="kv"><strong>${key}</strong></p>`);
      for (const value of values) {
        out.push(`<p class="kv-value">${inlineMarkdown(value)}</p>`);
      }
      sawContent = true;
      continue;
    }
    // 卡片式内容（审批、通知）没有 Markdown 标题：首行单独当标题，
    // 不能把随后的键行与正文一起吞进去
    if (titleFirst && !sawContent) {
      out.push(`<h1>${inlineMarkdown(stripped)}</h1>`);
      index += 1;
      sawContent = true;
      continue;
    }
    // 段落：合并连续非空行
    const para = [];
    while (index < total) {
      const row = lines[index].trim();
      if (row === '' || startsBlock(row)) break;
      para.push(row);
      index += 1;
    }
    if (para.length === 0) {
      index += 1; // 兜底：任何没被上面分支吃掉的行都不许原地打转
      continue;
    }
    out.push(`<p>${para.map(inlineMarkdown).join('<br>')}</p>`);
    sawContent = true;
  }
  return out.join('\n');
}

function pageHtml(text, options) {
  const body = markdownToHtml(text, { titleFirst: options.titleFirst });
  return `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{width:${options.width}px;background:${options.background};color:#2d333b;
  font-family:${FONT_STACK};font-size:${options.fontSize}px;line-height:1.62;
  padding:${options.paddingY}px ${options.paddingX}px;-webkit-font-smoothing:antialiased}
h1{font-size:29px;line-height:1.35;color:#111827;margin:0 0 16px;
  padding-bottom:12px;border-bottom:2px solid ${options.accent}}
h2{font-size:25px;line-height:1.3;color:#111827;margin:26px 0 12px;
  padding-left:14px;border-left:4px solid ${options.accent}}
h3{font-size:22px;line-height:1.35;color:#111827;margin:20px 0 10px}
h4,h5,h6{font-size:21px;color:#111827;margin:16px 0 8px}
p{margin:0 0 12px}
p.kv{margin:0 0 4px}
p.kv-value{margin:0 0 12px;padding-left:18px;color:#4a5260}
ul,ol{margin:0 0 12px;padding-left:24px}
ul ul,ol ul,ul ol,ol ol{margin:6px 0 0}
li{margin-bottom:5px}
strong{color:#111827}
blockquote{margin:0 0 14px;padding:8px 14px;background:#f6f7f8;
  border-left:3px solid #c9d2db;color:#55606b;font-size:19px}
code{font-family:${MONO_STACK};font-size:18px;background:#f2f4f6;
  padding:1px 5px;border-radius:3px}
pre{margin:0 0 14px;padding:12px 14px;background:#f6f7f8;border-radius:6px;
  white-space:pre-wrap;word-break:break-all}
pre code{background:none;padding:0;font-size:17px;line-height:1.5}
table{border-collapse:collapse;width:100%;margin:0 0 16px;font-size:18px}
th,td{border:1px solid #dfe3e8;padding:8px 10px;text-align:left;
  vertical-align:top;line-height:1.45;word-break:break-word}
th{background:#f2f5f8;color:#111827;white-space:nowrap}
tr:nth-child(even) td{background:#fbfcfd}
hr{border:none;border-top:1px solid #e3e7eb;margin:16px 0}
a{color:#1b4f7a;text-decoration:none;border-bottom:1px solid #dde3ea}
</style></head><body>
${body}
</body></html>`;
}

// ---------- 环境：chromium 与字体 ----------

let chromiumCache;

/** 找 headless chromium：环境变量 > Guix store > PATH。 */
export function findChromium() {
  if (chromiumCache !== undefined) return chromiumCache;
  const explicit = process.env.DSH_IM_CHROMIUM;
  if (explicit && existsSync(explicit)) {
    chromiumCache = explicit;
    return chromiumCache;
  }
  try {
    const entry = readdirSync('/gnu/store')
      .filter((name) => name.includes('-chromium'))
      .sort()
      .map((name) => `/gnu/store/${name}/bin/chromium`)
      .find((candidate) => existsSync(candidate));
    if (entry) {
      chromiumCache = entry;
      return chromiumCache;
    }
  } catch {
    // 非 Guix 系统没有 /gnu/store，继续走 PATH
  }
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'chrome']) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        chromiumCache = candidate;
        return chromiumCache;
      }
    }
  }
  chromiumCache = null;
  return chromiumCache;
}

/** 字体目录：XDG 约定 + Guix home profile（中文与彩色 emoji 都在后者）。 */
function fontDirectories() {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  const dataDirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share')
    .split(delimiter)
    .filter((entry) => entry !== '');
  const candidates = [
    join(dataHome, 'fonts'),
    ...dataDirs.map((dir) => join(dir, 'fonts')),
    join(homedir(), '.guix-home', 'profile', 'share', 'fonts'),
    join(homedir(), '.guix-profile', 'share', 'fonts'),
    join(homedir(), '.fonts'),
    '/usr/local/share/fonts',
    '/usr/share/fonts',
  ];
  return [...new Set(candidates)].filter((dir) => existsSync(dir));
}

/**
 * chromium 只认 FONTCONFIG_FILE，而 Guix 上没有 /etc/fonts/fonts.conf，
 * profile 自带的那份只扫 DejaVu。必须自己列出字体目录，否则中文缺字、
 * 彩色 emoji 掉成黑白轮廓。
 */
function ensureFontConfig() {
  if (process.env.DSH_IM_FONTCONFIG_FILE
    && existsSync(process.env.DSH_IM_FONTCONFIG_FILE)) {
    return process.env.DSH_IM_FONTCONFIG_FILE;
  }
  const dirs = fontDirectories();
  if (dirs.length === 0) return null;
  const cacheRoot = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  const configDir = join(cacheRoot, 'dsh-im');
  const configPath = join(configDir, 'fonts.conf');
  try {
    mkdirSync(join(configDir, 'fontconfig'), { recursive: true });
    writeFileSync(configPath, [
      '<?xml version="1.0"?>',
      '<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">',
      '<fontconfig>',
      ...dirs.map((dir) => `  <dir>${dir}</dir>`),
      `  <cachedir>${join(configDir, 'fontconfig')}</cachedir>`,
      '</fontconfig>',
      '',
    ].join('\n'), 'utf8');
  } catch {
    return null;
  }
  process.env.DSH_IM_FONTCONFIG_FILE = configPath;
  return configPath;
}

async function shoot(chromium, htmlPath, pngPath, options) {
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--screenshot=${pngPath}`,
    `--user-data-dir=${options.profileDir}`,
    `--window-size=${options.width},${options.canvasHeight}`,
    `file://${htmlPath}`,
  ];
  const env = { ...process.env };
  const fontConfig = ensureFontConfig();
  if (fontConfig) env.FONTCONFIG_FILE = fontConfig;
  await execFileAsync(chromium, args, {
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
    env,
  });
}

// ---------- 切分 ----------

const WHITE_SUM = 750; // 255 * 3 的近似白阈值

function rowIsBlank(rowBytes, channels) {
  for (let x = 0; x < rowBytes; x += channels) {
    const sum = channels >= 3
      ? rowBytes[x] + rowBytes[x + 1] + rowBytes[x + 2]
      : rowBytes[x] * 3;
    if (sum < WHITE_SUM) return false;
  }
  return true;
}

/** 在给定像素段里从底部往上找空白行，返回可用高度（含该行）。 */
function findCut(raw, width, height, channels, minHeight) {
  const stride = width * channels;
  for (let y = height - 1; y >= minHeight; y -= 1) {
    const start = y * stride;
    if (rowIsBlank(raw.subarray(start, start + stride), stride, 0)) return y + 1;
  }
  return height;
}

async function splitPages(sharp, pngBuffer, options) {
  const meta = await sharp(pngBuffer).metadata();
  const width = meta.width;
  const height = meta.height;

  // 先量真实内容高度：整图 raw 会有上百 MB，缩到 1/4 宽再扫，
  // 白背景 + 深色文字缩图后仍是灰块，判白阈值放宽一点即可
  const miniWidth = Math.max(64, Math.round(width / 4));
  const mini = await sharp(pngBuffer)
    .resize({ width: miniWidth, kernel: 'nearest' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const miniChannels = mini.info.channels;
  const scale = height / mini.info.height;
  let contentHeight = 0;
  const miniStride = miniWidth * miniChannels;
  for (let y = mini.info.height - 1; y >= 0; y -= 1) {
    const start = y * miniStride;
    const row = mini.data.subarray(start, start + miniStride);
    let blank = true;
    for (let x = 0; x < miniStride; x += miniChannels) {
      const sum = miniChannels >= 3
        ? row[x] + row[x + 1] + row[x + 2]
        : row[x] * 3;
      if (sum < 725) {
        blank = false;
        break;
      }
    }
    if (!blank) {
      contentHeight = Math.min(height, Math.round((y + 1) * scale) + 40);
      break;
    }
  }
  if (contentHeight === 0) return { images: [], omittedRows: 0, width, height: 0 };

  const images = [];
  let start = 0;
  while (start < contentHeight && images.length < options.maxImages) {
    const limit = Math.min(start + options.maxHeight, contentHeight);
    let end = limit;
    if (limit < contentHeight) {
      const windowTop = Math.max(start, limit - options.maxHeight);
      const windowHeight = limit - windowTop;
      const windowRaw = await sharp(pngBuffer)
        .extract({ left: 0, top: windowTop, width, height: windowHeight })
        .ensureAlpha(0)
        .raw()
        .toBuffer();
      const cut = findCut(windowRaw, width, windowHeight, 3,
        Math.floor(windowHeight / 2));
      end = windowTop + cut;
    }
    const page = await sharp(pngBuffer)
      .extract({ left: 0, top: start, width, height: end - start })
      .png({ compressionLevel: 9 })
      .toBuffer();
    images.push(page);
    start = end;
  }
  return {
    images,
    omittedRows: contentHeight - start > 0 ? 1 : 0,
    width,
    height: contentHeight,
  };
}

// ---------- 对外入口 ----------

/**
 * 把 markdown 渲染成 1..maxImages 张竖长图。
 * 返回 { images: Buffer[], omittedRows }；任何环节失败都返回空 images。
 */
export async function renderMarkdownImages(text, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const sharp = await loadSharp();
  if (!sharp) return { images: [], omittedRows: 0 };
  const chromium = findChromium();
  if (!chromium) return { images: [], omittedRows: 0 };
  const workDir = await mkdtemp(join(tmpdir(), 'dsh-im-md-'));
  try {
    const htmlPath = join(workDir, 'report.html');
    const pngPath = join(workDir, 'report.png');
    await writeFile(htmlPath, pageHtml(String(text), settings), 'utf8');
    await shoot(chromium, htmlPath, pngPath, { ...settings, profileDir: join(workDir, 'chromium') });
    const png = await readFile(pngPath);
    if (png.length < 1000) return { images: [], omittedRows: 0 };
    const result = await splitPages(sharp, png, settings);
    return { images: result.images, omittedRows: result.omittedRows };
  } catch {
    return { images: [], omittedRows: 0 };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** 供测试与诊断：渲染出的 HTML（不截图）。 */
export function renderHtml(text, options = {}) {
  return pageHtml(String(text), { ...DEFAULTS, ...options });
}
