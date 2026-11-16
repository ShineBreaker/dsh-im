// 长文本 / 卡片渲染的统一入口。
//
// 渲染后端是 markdown-image.mjs 的 HTML + headless chromium：表格、列表、
// 引用、代码块按真实结构排版，彩色 emoji 正常出图。早先用等宽 SVG
// （sharp 内置 libvips + pango）拼字，markdown 标记只能剥掉不能渲染，
// 表格变成 `|` 竖线原文、emoji 掉成黑白轮廓，已废弃。
//
// 接口保持不变：{ images: Buffer[], omittedRows }，调用方无需改动；
// 渲染不是必需路径，失败一律返回空数组，调用方回退文本。

import { renderMarkdownImages } from './markdown-image.mjs';

/**
 * 把文本渲染成 1..maxImages 张 PNG。
 * @param {string} text Markdown 或结构化文本
 * @param {{ signal?: AbortSignal, width?: number, maxImages?: number,
 *   accent?: string, titleFirst?: boolean, maxHeight?: number }} [options]
 * @returns {Promise<{ images: Buffer[], omittedRows: number }>}
 */
export async function renderTextImages(text, { signal, ...overrides } = {}) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { images: [], omittedRows: 0 };
  }
  signal?.throwIfAborted();
  const options = {};
  if (Number.isFinite(overrides.width)) options.width = overrides.width;
  if (Number.isFinite(overrides.maxHeight)) options.maxHeight = overrides.maxHeight;
  if (typeof overrides.accent === 'string' && overrides.accent.trim()) {
    options.accent = overrides.accent.trim();
  }
  if (overrides.titleFirst === true) options.titleFirst = true;
  if (Number.isFinite(overrides.maxImages)) options.maxImages = overrides.maxImages;
  const result = await renderMarkdownImages(text, options);
  signal?.throwIfAborted();
  return result;
}
