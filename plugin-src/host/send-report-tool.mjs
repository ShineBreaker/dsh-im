/**
 * 内置 dsh_im_send_report 工具 —— 把一整份报告（Markdown 文本或 .md 文件）
 * 一步投递到已保存的 IM 目标：短内容按 Markdown 发文本，长内容先渲染成
 * 竖长图再逐张发送，渲染失败时回退文本，内容不会丢。
 *
 * 取代旧的 dsh_im_render_text（渲染完还要调用方自己再发一次）。
 * 发任意本地文件（图片/视频/附件）仍走 dsh_im_push_media。
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderTextImages } from '../../src/channels/shared/text-image.mjs';

export const SEND_REPORT_TOOL_NAME = 'dsh_im_send_report';

const DEFAULT_THRESHOLD = 300;

const DESCRIPTION = 'Deliver a report to a saved IM target in one call: short text is sent '
  + 'as a Markdown message, long text is rendered to one or more vertical PNG pages and '
  + 'pushed as images (falls back to plain text if rendering is unavailable). Use this from '
  + 'scheduled/unattended runs instead of rendering and sending separately. Requires botId '
  + 'and targetId from the saved delivery targets, plus either text or an absolute .md path.';

function buildDefinition(service) {
  return {
    name: SEND_REPORT_TOOL_NAME,
  description: DESCRIPTION,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      botId: {
        type: 'string',
        description: 'Bot ID of the configured IM bot, copied from the delivery target settings.',
      },
      targetId: {
        type: 'string',
        description: 'Saved delivery target ID, e.g. tgt_7fac8f78eeeae510.',
      },
      text: {
        type: 'string',
        description: 'Report body in Markdown. Omit when path is given.',
      },
      path: {
        type: 'string',
        description: 'Absolute path of a Markdown report file. Omit when text is given.',
      },
      imageThreshold: {
        type: 'integer',
        minimum: 0,
        description: 'Render to images when the body exceeds this many characters. '
          + 'Default 300; 0 renders everything except empty input.',
      },
      maxImages: {
        type: 'integer',
        minimum: 1,
        maximum: 6,
        description: 'Maximum number of image pages, default 3.',
      },
    },
    required: ['botId', 'targetId'],
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sent: { type: 'boolean' },
        mode: { type: 'string', enum: ['text', 'image'] },
        images: { type: 'integer' },
        chars: { type: 'integer' },
        truncated: { type: 'boolean' },
      },
      required: ['sent', 'mode', 'images', 'chars', 'truncated'],
    },
    render: (_args, value) => [{
      type: 'text',
      text: value.mode === 'image'
        ? `已投递 ${value.images} 张图片到 IM 目标（正文 ${value.chars} 字）。`
        : `已投递文本到 IM 目标（${value.chars} 字）。`,
    }],
  },
  async execute(args) {
    const botId = typeof args?.botId === 'string' ? args.botId.trim() : '';
    const targetId = typeof args?.targetId === 'string' ? args.targetId.trim() : '';
    if (!botId) throw new Error('dsh_im_send_report: botId 必填');
    if (!targetId) throw new Error('dsh_im_send_report: targetId 必填');

    let body = typeof args?.text === 'string' ? args.text : '';
    if (!body.trim()) {
      const path = typeof args?.path === 'string' ? args.path.trim() : '';
      if (!path) throw new Error('dsh_im_send_report: text 与 path 至少给一个');
      if (!existsSync(path)) throw new Error(`dsh_im_send_report: 文件不存在 ${path}`);
      body = await readFile(path, 'utf8');
    }
    if (!body.trim()) throw new Error('dsh_im_send_report: 正文为空');

    const threshold = Number.isInteger(args?.imageThreshold) && args.imageThreshold >= 0
      ? args.imageThreshold
      : DEFAULT_THRESHOLD;
    const maxImages = Number.isInteger(args?.maxImages) && args.maxImages > 0
      ? Math.min(args.maxImages, 6)
      : 3;

    if (threshold > 0 && body.length > threshold) {
      const { images, omittedRows } = await renderTextImages(body, { maxImages });
      if (images.length > 0) {
        // 图片落在宿主临时目录：宿主进程负责读取与上传，会话沙箱的 /tmp 它看不到
        const dir = await mkdtemp(join(tmpdir(), 'dsh-im-report-'));
        try {
          for (const [index, buffer] of images.entries()) {
            const path = join(dir, `report-${index + 1}.png`);
            await writeFile(path, buffer);
            await service.sendMedia(botId, targetId, { path }, index === 0
              ? { text: `报告较长，已转为 ${images.length} 张图片。` }
              : {});
          }
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
        return {
          sent: true,
          mode: 'image',
          images: images.length,
          chars: body.length,
          truncated: omittedRows > 0,
        };
      }
    }

    await service.send(botId, targetId, body, { format: 'markdown' });
    return {
      sent: true,
      mode: 'text',
      images: 0,
      chars: body.length,
      truncated: false,
    };
  },
  };
}

/** 注册报告投递工具。service 通过 this 绑定进 execute。 */
export function installSendReportTool(ctx, service, { logger } = {}) {
  if (typeof ctx?.tools?.register !== 'function') {
    logger?.warn?.('[dsh-im] tools service unavailable, dsh_im_send_report not registered');
    return false;
  }
  if (typeof service?.send !== 'function' || typeof service?.sendMedia !== 'function') {
    logger?.warn?.('[dsh-im] delivery service incomplete, dsh_im_send_report not registered');
    return false;
  }
  ctx.tools.register(buildDefinition(service));
  return true;
}
