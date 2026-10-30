import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { ensurePresetWorkspace } from '../src/channels/shared/preset-workspaces.mjs';
import {
  BotWorkspaceStore,
  createBotWorkspaceScope,
  createWorkspaceAwareController,
} from '../src/channels/shared/bot-workspace-store.mjs';
import { ConversationStateStore } from '../src/channels/shared/conversation-state-store.mjs';
import { askInWorkspaceSession } from '../src/channels/shared/workspace-session.mjs';

const catalog = {
  defaultId: 'standard',
  items: [
    { id: 'research', label: 'Research' },
    { id: 'other', label: '其他研究' },
  ],
};
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'im-preset-group-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, 'im');
  await mkdir(base);
  const manual = join(root, 'manual');
  await mkdir(manual);
  const items = [],
    calls = [],
    sessions = [];
  const harness = {
    isUngroupedWorkspace: async (p) => p === base,
    rpc: async (method, payload) => {
      calls.push({ method, payload });
      if (method === 'workspace.list') return { items: structuredClone(items) };
      if (method === 'workspace.create') {
        let workspace = items.find((i) => i.path === payload.path);
        const created = !workspace;
        if (!workspace) {
          workspace = {
            workspaceId: `group-${items.length}`,
            path: payload.path,
            title: basename(payload.path),
            sessionIds: [],
          };
          items.push(workspace);
        }
        return { workspace: structuredClone(workspace), created };
      }
      if (method === 'workspace.rename') {
        const workspace = items.find((i) => i.workspaceId === payload.workspaceId);
        workspace.title = payload.title;
        return { workspace: structuredClone(workspace) };
      }
      throw new Error('Unexpected RPC');
    },
    createSession: async (options) => {
      const sessionId = `session-${sessions.length}`;
      sessions.push({ sessionId, options });
      return sessionId;
    },
    sessionExists: async () => true,
    ask: async (sessionId) => sessionId,
  };
  return { root, base, manual, items, calls, sessions, harness };
}

test('same explicit preset reuses one group; Host default creates no group', async (t) => {
  const f = await fixture(t);
  assert.equal(await ensurePresetWorkspace(f.harness, f.base, null, catalog), f.base);
  assert.equal(f.items.length, 0);
  const first = await ensurePresetWorkspace(f.harness, f.base, 'research', catalog);
  const second = await ensurePresetWorkspace(f.harness, f.base, 'research', catalog);
  assert.equal(first, second);
  assert.equal(f.items.length, 1);
  assert.equal(f.items[0].title, 'Research');
  await ensurePresetWorkspace(f.harness, f.base, 'other', catalog);
  assert.equal(f.items.length, 2);
});

test('manual workspace wins; a user-renamed automatic group keeps its title', async (t) => {
  const f = await fixture(t);
  assert.equal(await ensurePresetWorkspace(f.harness, f.manual, 'research', catalog), f.manual);
  assert.equal(f.calls.length, 0);
  await ensurePresetWorkspace(f.harness, f.base, 'research', catalog);
  f.items[0].title = '我的研究';
  await ensurePresetWorkspace(f.harness, f.base, 'research', catalog);
  assert.equal(f.items[0].title, '我的研究');
});

test('an unrelated same-name workspace is preserved; the preset group has an unambiguous name', async (t) => {
  const f = await fixture(t);
  f.items.push({ workspaceId: 'manual', path: f.manual, title: 'Research' });
  await ensurePresetWorkspace(f.harness, f.base, 'research', catalog);
  assert.equal(f.items[0].title, 'Research');
  assert.equal(f.items[1].title, 'Research（research）');
});

test('selecting a preset creates its group without changing old bindings; only new chats use it', async (t) => {
  const f = await fixture(t);
  const workspaces = await new BotWorkspaceStore(join(f.root, 'workspaces.json'), {
    defaultWorkspace: f.base,
    groupByAgentPreset: true,
  }).load();
  await workspaces.ensure('bot');
  const state = await new ConversationStateStore(join(f.root, 'state.json')).load();
  const scope = createBotWorkspaceScope(f.harness, {
    botId: 'bot',
    workspaces,
    state,
    agentPresetCatalog: catalog,
  });
  const ask = () => askInWorkspaceSession({ ...scope, key: 'chat:existing', text: 'continue' });
  const first = await ask();
  const controller = createWorkspaceAwareController(
    { status: async () => ({ bots: [{ botId: 'bot', bot: { name: 'Bot' } }] }) },
    { workspaces, stateFor: async () => state, agentPresetCatalog: catalog, harness: f.harness },
  );
  await controller.updateAgentPreset('bot', 'research');
  assert.equal(f.items[0].title, 'Research');
  assert.equal(state.sessionFor('chat:existing'), first.sessionId);
  assert.equal((await ask()).sessionId, first.sessionId);
  assert.equal(f.sessions[0].options.workspace, f.base);
  await state.clearSession('chat:existing');
  await ask();
  assert.equal(f.sessions[1].options.workspace, join(f.base, 'presets', 'research'));
  assert.equal(f.sessions[1].options.agentPreset, 'research');
  assert.equal(f.sessions.length, 2);
});

test('a workspace creation failure leaves selected preset and existing mappings unchanged', async (t) => {
  const f = await fixture(t);
  const workspaces = await new BotWorkspaceStore(join(f.root, 'workspaces.json'), {
    defaultWorkspace: f.base,
    groupByAgentPreset: true,
  }).load();
  await workspaces.ensure('bot');
  const state = await new ConversationStateStore(join(f.root, 'state.json')).load();
  await state.setSession('chat', 'old');
  f.harness.rpc = async () => {
    throw new Error('Host unavailable');
  };
  const controller = createWorkspaceAwareController(
    { status: async () => ({ bots: [{ botId: 'bot' }] }) },
    { workspaces, stateFor: async () => state, agentPresetCatalog: catalog, harness: f.harness },
  );
  await assert.rejects(controller.updateAgentPreset('bot', 'research'), /Host unavailable/);
  assert.equal(workspaces.agentPresetFor('bot'), null);
  assert.equal(state.sessionFor('chat'), 'old');
});

test('different bot state stores in the same preset share only the group, not session memory', async (t) => {
  const f = await fixture(t);
  const workspaces = await new BotWorkspaceStore(join(f.root, 'workspaces.json'), {
    defaultWorkspace: f.base,
    groupByAgentPreset: true,
  }).load();
  for (const botId of ['bot_one', 'bot_two']) {
    await workspaces.ensure(botId, { defaultAgentPreset: 'research' });
    const state = await new ConversationStateStore(join(f.root, `${botId}.json`)).load();
    const scope = createBotWorkspaceScope(f.harness, {
      botId,
      workspaces,
      state,
      agentPresetCatalog: catalog,
    });
    await askInWorkspaceSession({ ...scope, key: 'chat:one', text: 'test' });
  }
  assert.equal(f.items.length, 1);
  assert.notEqual(f.sessions[0].sessionId, f.sessions[1].sessionId);
  assert.equal(f.sessions[0].options.workspace, f.sessions[1].options.workspace);
});

test('grouping is off by default, including preset changes and subsequent new sessions', async (t) => {
  const f = await fixture(t);
  const workspaces = await new BotWorkspaceStore(join(f.root, 'workspaces.json'), { defaultWorkspace: f.base }).load();
  await workspaces.ensure('bot');
  const state = await new ConversationStateStore(join(f.root, 'state.json')).load();
  const controller = createWorkspaceAwareController(
    { status: async () => ({ bots: [{ botId: 'bot' }] }) },
    { workspaces, stateFor: async () => state, agentPresetCatalog: catalog, harness: f.harness },
  );
  await controller.updateAgentPreset('bot', 'research');
  const scope = createBotWorkspaceScope(f.harness, { botId: 'bot', workspaces, state, agentPresetCatalog: catalog });
  await askInWorkspaceSession({ ...scope, key: 'chat', text: 'hello' });
  assert.equal(f.items.length, 0);
  assert.equal(f.sessions[0].options.workspace, f.base);
  assert.equal(f.sessions[0].options.agentPreset, 'research');
});

test('conversation overrides and Feishu directory isolation take precedence over grouping', async (t) => {
  const f = await fixture(t);
  const workspaces = await new BotWorkspaceStore(join(f.root, 'workspaces.json'), {
    defaultWorkspace: f.base, groupByAgentPreset: true,
  }).load();
  await workspaces.ensure('bot', { defaultAgentPreset: 'research' });
  const state = await new ConversationStateStore(join(f.root, 'state.json')).load();
  const scope = createBotWorkspaceScope(f.harness, { botId: 'bot', workspaces, state, agentPresetCatalog: catalog });
  await scope.harness.switchConversationWorkspace('manual', f.manual);
  await askInWorkspaceSession({ ...scope, key: 'manual', text: 'hello' });
  assert.equal(f.sessions[0].options.workspace, f.manual);
  assert.equal(f.items.length, 0);
  await workspaces.setConversationDirectory('bot', { enabled: true });
  await askInWorkspaceSession({ ...scope, key: 'isolated', text: 'hello' });
  assert.equal(f.sessions[1].options.workspace, workspaces.conversationWorkspaceFor('bot', 'isolated'));
  assert.notEqual(f.sessions[1].options.workspace, f.base);
  assert.notEqual(dirname(f.sessions[1].options.workspace), join(f.base, 'presets'));
  assert.equal(f.items.length, 0);
});
