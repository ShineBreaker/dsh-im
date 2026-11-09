// 长文本渲染工具：agent 把要发的长内容交给它，拿回图片路径，
// 再用 dsh_im_return_file 发送。渲染器与审批卡片共用 text-image.mjs。

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderTextImages } from './text-image.mjs';

export const RENDER_TEXT_TOOL = 'dsh_im_render_text';

const definition = Object.freeze({
  name: RENDER_TEXT_TOOL,
  description: '把长文本渲染成等宽长图并返回 PNG 路径；随后用 dsh_im_return_file 发送。'
    + '适合超过一屏的总结、报告、清单：图片在聊天里只占一个缩略图，比整屏文字好翻。'
    + '渲染失败时返回空列表，此时请改为直接回复文本。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string', description: '要渲染的 Markdown 或纯文本。' },
      maxImages: { type: 'integer', minimum: 1, maximum: 6, description: '最多渲染几张，默认 3。' },
      accent: { type: 'string', description: '标题色条颜色，如 #b4534b；默认蓝灰。' },
      titleFirst: { type: 'boolean', description: '把首行当标题渲染，适合卡片式短内容。' },
    },
    required: ['text'],
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        images: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string' },
              bytes: { type: 'integer' },
            },
            required: ['path', 'bytes'],
          },
        },
        omittedRows: { type: 'integer' },
      },
      required: ['images', 'omittedRows'],
    },
  },
  async execute(args) {
    const { images, omittedRows } = await renderTextImages(args.text, {
      maxImages: args.maxImages ?? 3,
      ...(args.accent ? { accent: args.accent } : {}),
      titleFirst: args.titleFirst === true,
    });
    if (images.length === 0) return { images: [], omittedRows: 0 };
    // 工具跑在宿主进程里，tmpdir 对宿主可读；不要写到会话沙箱的 /tmp
    const dir = await mkdtemp(join(tmpdir(), 'dsh-im-render-'));
    const results = [];
    for (const [index, buffer] of images.entries()) {
      const path = join(dir, `render-${index + 1}.png`);
      await writeFile(path, buffer);
      results.push({ path, bytes: buffer.length });
    }
    return { images: results, omittedRows };
  },
});

/** 注册长文本渲染工具。 */
export function installRenderTextTool(ctx) {
  if (typeof ctx?.tools?.register !== 'function') return false;
  ctx.tools.register(definition);
  return true;
}
