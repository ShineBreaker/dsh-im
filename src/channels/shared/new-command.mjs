import { t } from './i18n.mjs';

/**
 * The reply text for a `/new` that a DS Bot binding refuses.
 *
 * A conversation bound to a DS Bot is owned by that bot: its Session comes
 * from the DS Bot, not from this bot's session map, so clearing the map would
 * silently do nothing while leaving the user with a stale conversation. The
 * refusal is a deliberate, recoverable state — the user unbinds the DS Bot and
 * tries again — so it must read as an instruction, not as an internal fault.
 *
 * Returns null for every other error: the caller keeps its own handling.
 */
export function newConversationRefusalText(error) {
  if (error?.code === 'ds-bot-bound') {
    return t('当前会话已绑定 DS Bot，无法开启新会话。请先在「绑定 DS Bot」中解除绑定后再试。');
  }
  return null;
}

export async function startNewConversation({ state, harness, key }) {
  const result = await harness.prepareConversationDirectory?.(key, { explicitNew: true });
  await state.clearSession(key);
  return [t('已开启全新 Harness 会话。'), result?.warning ? t(result.warning) : null].filter(Boolean).join('\n');
}
