import assert from 'node:assert/strict';
import test from 'node:test';
import Bridge, { createSessionKeyboard, formatSessionButtonLabel } from '../src/bridge.js';

function makeSession(index, overrides = {}) {
  return {
    id: `session-${index}`,
    agentType: index % 2 === 0 ? 'codex' : 'claude',
    title: `Prompt ${index}`,
    lastUserMessage: `Last prompt ${index}`,
    lastUserMessageAt: '2026-05-29T09:45:00.000Z',
    project: `project-${index}`,
    cwd: `/tmp/project-${index}`,
    model: null,
    resumable: true,
    ...overrides,
  };
}

test('formatSessionButtonLabel produces compact provider project time title text', () => {
  const label = formatSessionButtonLabel(
    makeSession(1, {
      agentType: 'claude',
      project: 'heyagent',
      title: 'Add Telegram session picker support',
      lastUserMessageAt: '2026-05-29T09:50:00.000Z',
    }),
    new Date('2026-05-29T10:02:00.000Z')
  );

  assert.equal(label, 'Claude | heyagent | 12m | Add Telegram session picker support');
});

test('formatSessionButtonLabel falls back to last user message and unknown project', () => {
  const label = formatSessionButtonLabel(
    makeSession(2, {
      agentType: 'codex',
      project: null,
      title: null,
      lastUserMessage: 'Continue from here',
      lastUserMessageAt: '2026-05-29T08:02:00.000Z',
    }),
    new Date('2026-05-29T10:02:00.000Z')
  );

  assert.equal(label, 'Codex | unknown | 2h | Continue from here');
});

test('formatSessionButtonLabel truncates long labels', () => {
  const label = formatSessionButtonLabel(
    makeSession(3, {
      title: 'This is an intentionally long prompt title that should not take over the Telegram keyboard',
    }),
    new Date('2026-05-29T10:02:00.000Z')
  );

  assert.ok(label.length <= 64);
  assert.ok(label.endsWith('...'));
});

test('createSessionKeyboard limits to 20 sessions and registers callback tokens', () => {
  const registered = new Map();
  const sessions = Array.from({ length: 25 }, (_, index) => makeSession(index + 1));
  const keyboard = createSessionKeyboard(sessions, session => {
    const token = `sess_${session.id}`;
    registered.set(token, session);
    return token;
  });

  assert.equal(keyboard.inline_keyboard.length, 20);
  assert.equal(keyboard.inline_keyboard[0][0].callback_data, 'sess_session-1');
  assert.equal(keyboard.inline_keyboard[19][0].callback_data, 'sess_session-20');
  assert.equal(registered.size, 20);
  assert.equal(registered.get('sess_session-1').id, 'session-1');
});

test('handleSessionPickerCallback selects provider session id and cwd', async () => {
  const data = {
    provider: 'claude',
    claudeArgs: [],
    codexArgs: [],
    claudeLastSessionId: null,
    codexLastSessionId: null,
    telegramChatId: 'chat-1',
  };
  const sentMessages = [];
  const answeredCallbacks = [];
  const config = {
    get claudeArgs() {
      return data.claudeArgs;
    },
    get codexArgs() {
      return data.codexArgs;
    },
    get claudeLastSessionId() {
      return data.claudeLastSessionId;
    },
    get codexLastSessionId() {
      return data.codexLastSessionId;
    },
    get telegramChatId() {
      return data.telegramChatId;
    },
    get telegramBotUsername() {
      return null;
    },
    set(key, value) {
      data[key] = value;
    },
    setMany(updates) {
      Object.assign(data, updates);
    },
    clearPairing() {},
  };
  const bridge = new Bridge(config, 'claude', []);
  bridge.logCliEvent = () => {};
  bridge.telegram = {
    sendMessage(chatId, text) {
      sentMessages.push({ chatId, text });
    },
    answerCallbackQuery(callbackQueryId, text) {
      answeredCallbacks.push({ callbackQueryId, text });
    },
  };
  const session = makeSession(1, {
    agentType: 'codex',
    id: 'codex-session',
    cwd: '/Users/geert/code/selected',
    project: 'selected',
    title: 'Selected work',
  });
  bridge.sessionPickerEntries.set('sess_token', session);

  await bridge.handleSessionPickerCallback({
    type: 'callback',
    callbackQueryId: 'callback-1',
    data: 'sess_token',
    chatId: 'chat-1',
  });

  assert.equal(bridge.provider, 'codex');
  assert.equal(data.provider, 'codex');
  assert.equal(data.codexLastSessionId, 'codex-session');
  assert.equal(bridge.selectedSessionCwd, '/Users/geert/code/selected');
  assert.equal(bridge.forceNewNextPrompt, false);
  assert.deepEqual(answeredCallbacks, [{ callbackQueryId: 'callback-1', text: 'Codex geselecteerd' }]);
  assert.equal(sentMessages[0].chatId, 'chat-1');
  assert.match(sentMessages[0].text, /Selected Codex session/);
});
