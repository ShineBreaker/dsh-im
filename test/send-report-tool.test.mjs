import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  SEND_REPORT_TOOL_NAME,
  installSendReportTool,
} from '../plugin-src/host/send-report-tool.mjs';

function harness() {
  const registered = [];
  const calls = [];
  const ctx = { tools: { register: (definition) => registered.push(definition) } };
  const service = {
    async send(botId, targetId, text, options) {
      calls.push({ kind: 'text', botId, targetId, text, options });
      return { sent: true };
    },
    async sendMedia(botId, targetId, media, options) {
      calls.push({ kind: 'media', botId, targetId, media, options });
      return { fileName: 'x.png', size: 1 };
    },
  };
  installSendReportTool(ctx, service);
  return { registered, calls, tool: registered[0] };
}

test('registers one tool with the documented name and schema', () => {
  const { registered, tool } = harness();
  assert.equal(registered.length, 1);
  assert.equal(tool.name, SEND_REPORT_TOOL_NAME);
  assert.deepEqual(tool.parameters.required, ['botId', 'targetId']);
  assert.equal(tool.parameters.properties.path.type, 'string');
});

test('short bodies go out as a markdown message', async () => {
  const { calls, tool } = harness();
  const result = await tool.execute({
    botId: 'qq_1',
    targetId: 'tgt_1',
    text: '短报告正文',
  });
  assert.deepEqual(result, {
    sent: true, mode: 'text', images: 0, chars: 5, truncated: false,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'text');
  assert.equal(calls[0].options.format, 'markdown');
});

test('path is read when text is absent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'send-report-test-'));
  try {
    const file = join(dir, 'report.md');
    await writeFile(file, '# 标题\n正文', 'utf8');
    const { calls, tool } = harness();
    const result = await tool.execute({ botId: 'b', targetId: 't', path: file });
    assert.equal(result.mode, 'text');
    assert.equal(result.chars, '# 标题\n正文'.length);
    assert.match(calls[0].text, /^# 标题/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('missing ids, empty body and missing file are rejected', async () => {
  const { tool } = harness();
  await assert.rejects(tool.execute({ targetId: 't', text: 'x' }), /botId/u);
  await assert.rejects(tool.execute({ botId: 'b', text: 'x' }), /targetId/u);
  await assert.rejects(tool.execute({ botId: 'b', targetId: 't' }), /text 与 path/u);
  await assert.rejects(
    tool.execute({ botId: 'b', targetId: 't', path: '/nonexistent/x.md' }),
    /文件不存在/u,
  );
});

test('a service without sendMedia still registers nothing and warns', () => {
  const registered = [];
  const ctx = { tools: { register: (d) => registered.push(d) } };
  const warnings = [];
  const ok = installSendReportTool(ctx, { send: async () => ({}) }, {
    logger: { warn: (message) => warnings.push(message) },
  });
  assert.equal(ok, false);
  assert.equal(registered.length, 0);
  assert.match(warnings[0], /delivery service incomplete/u);
});
