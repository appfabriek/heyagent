import assert from 'node:assert/strict';
import test from 'node:test';
import Bridge, { createSessionKeyboard, createSessionProjectKeyboard, formatSessionButtonLabel, groupSessionsByProject } from '../src/bridge.js';

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

test('formatSessionButtonLabel puts the session title first', () => {
  const label = formatSessionButtonLabel(
    makeSession(1, {
      agentType: 'claude',
      project: 'heyagent',
      title: 'Add Telegram session picker support',
      lastUserMessageAt: '2026-05-29T09:50:00.000Z',
    }),
    new Date('2026-05-29T10:02:00.000Z')
  );

  assert.equal(label, 'Add Telegram session picker support | Claude | heyagent | 12m');
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

  assert.equal(label, 'Continue from here | Codex | unknown | 2h');
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

test('groupSessionsByProject limits before grouping and keeps newest project first', () => {
  const sessions = Array.from({ length: 25 }, (_, index) =>
    makeSession(index + 1, {
      project: index === 24 ? 'outside-limit' : index % 2 === 0 ? 'alpha' : 'beta',
    })
  );

  const groups = groupSessionsByProject(sessions, { limit: 20 });

  assert.equal(groups.length, 2);
  assert.equal(groups[0].project, 'alpha');
  assert.equal(groups[0].sessions.length, 10);
  assert.equal(groups[1].project, 'beta');
  assert.equal(groups[1].sessions.length, 10);
  assert.equal(
    groups.some(group => group.project === 'outside-limit'),
    false
  );
});

test('createSessionProjectKeyboard opens multi-session projects and directly selects single-session projects', () => {
  const registeredProjects = new Map();
  const registeredSessions = new Map();
  const sessions = [
    makeSession(1, {
      id: 'alpha-new',
      project: 'alpha',
      agentType: 'claude',
      title: 'New alpha work',
      lastUserMessageAt: '2026-05-29T09:50:00.000Z',
    }),
    makeSession(2, {
      id: 'beta-only',
      project: 'beta',
      agentType: 'codex',
      title: 'Only beta work',
      lastUserMessageAt: '2026-05-29T09:45:00.000Z',
    }),
    makeSession(3, {
      id: 'alpha-old',
      project: 'alpha',
      agentType: 'codex',
      title: 'Older alpha work',
      lastUserMessageAt: '2026-05-29T09:20:00.000Z',
    }),
  ];

  const keyboard = createSessionProjectKeyboard(
    sessions,
    session => {
      const token = `sess_${session.id}`;
      registeredSessions.set(token, session);
      return token;
    },
    group => {
      const token = `proj_${group.project}`;
      registeredProjects.set(token, group);
      return token;
    },
    { now: new Date('2026-05-29T10:02:00.000Z') }
  );

  assert.equal(keyboard.inline_keyboard.length, 2);
  assert.equal(keyboard.inline_keyboard[0][0].callback_data, 'proj_alpha');
  assert.match(keyboard.inline_keyboard[0][0].text, /^alpha \| 2 sessies \| nieuwste 12m/);
  assert.equal(keyboard.inline_keyboard[1][0].callback_data, 'sess_beta-only');
  assert.match(keyboard.inline_keyboard[1][0].text, /^Only beta work \| Codex \| beta \| 17m/);
  assert.deepEqual(
    registeredProjects.get('proj_alpha').sessions.map(session => session.id),
    ['alpha-new', 'alpha-old']
  );
  assert.equal(registeredSessions.get('sess_beta-only').id, 'beta-only');
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

test('handleSessionPickerCallback stops active prompt and clears queued messages before switching', async () => {
  const data = {
    provider: 'claude',
    claudeArgs: [],
    codexArgs: [],
    claudeLastSessionId: 'old-claude-session',
    codexLastSessionId: null,
    telegramChatId: 'chat-1',
  };
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
    sendMessage() {},
    answerCallbackQuery() {},
  };
  const abortController = new globalThis.AbortController();
  bridge.activePromptAbortController = abortController;
  bridge.telegramPendingMessages = ['queued for old session'];
  bridge.sessionPickerEntries.set(
    'sess_token',
    makeSession(1, {
      agentType: 'codex',
      id: 'codex-session',
      cwd: '/Users/geert/code/selected',
    })
  );

  await bridge.handleSessionPickerCallback({
    type: 'callback',
    callbackQueryId: 'callback-1',
    data: 'sess_token',
    chatId: 'chat-1',
  });

  assert.equal(abortController.signal.aborted, true);
  assert.equal(bridge.activePromptAbortReason, 'session_switch');
  assert.deepEqual(bridge.telegramPendingMessages, []);
  assert.equal(bridge.provider, 'codex');
  assert.equal(data.codexLastSessionId, 'codex-session');
});

test('handleSessionProjectCallback shows sessions for a multi-session project', async () => {
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
    sendMessage(chatId, text, options) {
      sentMessages.push({ chatId, text, options });
    },
    answerCallbackQuery(callbackQueryId, text) {
      answeredCallbacks.push({ callbackQueryId, text });
    },
  };
  bridge.sessionPickerProjectEntries.set('proj_alpha', {
    project: 'alpha',
    sessions: [
      makeSession(1, { id: 'alpha-new', project: 'alpha', title: 'New alpha work' }),
      makeSession(2, { id: 'alpha-old', project: 'alpha', title: 'Older alpha work' }),
    ],
  });

  await bridge.handleSessionProjectCallback({
    type: 'callback',
    callbackQueryId: 'callback-1',
    data: 'proj_alpha',
    chatId: 'chat-1',
  });

  assert.deepEqual(answeredCallbacks, [{ callbackQueryId: 'callback-1', text: 'alpha' }]);
  assert.equal(sentMessages[0].chatId, 'chat-1');
  assert.match(sentMessages[0].text, /Kies een sessie voor alpha/);
  assert.equal(sentMessages[0].options.replyMarkup.inline_keyboard.length, 2);
  assert.equal(new Set([...bridge.sessionPickerEntries.values()].map(session => session.id)).size, 2);
});

test('handleCommand accepts bot-suffixed sessions command from Telegram menu', async () => {
  const config = {
    get claudeArgs() {
      return [];
    },
    get codexArgs() {
      return [];
    },
    get claudeLastSessionId() {
      return null;
    },
    get codexLastSessionId() {
      return null;
    },
    get telegramChatId() {
      return 'chat-1';
    },
    get telegramBotUsername() {
      return 'RegelneefBot';
    },
    set() {},
    setMany() {},
    clearPairing() {},
  };
  const bridge = new Bridge(config, 'claude', []);
  let showSessionPickerCalls = 0;
  bridge.showSessionPicker = async () => {
    showSessionPickerCalls += 1;
  };
  bridge.safeSendMessage = async () => {
    throw new Error('Expected /sessions command to open picker');
  };

  await bridge.handleCommand('/sessions@RegelneefBot');

  assert.equal(showSessionPickerCalls, 1);
});

test('handleCommand accepts Dutch sessions alias', async () => {
  const config = {
    get claudeArgs() {
      return [];
    },
    get codexArgs() {
      return [];
    },
    get claudeLastSessionId() {
      return null;
    },
    get codexLastSessionId() {
      return null;
    },
    get telegramChatId() {
      return 'chat-1';
    },
    get telegramBotUsername() {
      return 'RegelneefBot';
    },
    set() {},
    setMany() {},
    clearPairing() {},
  };
  const bridge = new Bridge(config, 'claude', []);
  let showSessionPickerCalls = 0;
  bridge.showSessionPicker = async () => {
    showSessionPickerCalls += 1;
  };
  bridge.safeSendMessage = async () => {
    throw new Error('Expected /sessies command to open picker');
  };

  await bridge.handleCommand('/sessies');

  assert.equal(showSessionPickerCalls, 1);
});

test('configureTelegramCommands registers session commands for the paired chat', async () => {
  const config = {
    get claudeArgs() {
      return [];
    },
    get codexArgs() {
      return [];
    },
    get claudeLastSessionId() {
      return null;
    },
    get codexLastSessionId() {
      return null;
    },
    get telegramChatId() {
      return '6314031751';
    },
    get telegramBotUsername() {
      return 'RegelneefBot';
    },
    set() {},
    setMany() {},
    clearPairing() {},
  };
  const bridge = new Bridge(config, 'claude', []);
  const calls = [];

  await bridge.configureTelegramCommands({
    async setCommands(commands, options) {
      calls.push({ commands, options });
    },
  });

  assert.deepEqual(
    calls[0].commands.map(command => command.command),
    ['help', 'new', 'stop', 'claude', 'codex', 'sessions', 'sessies', 'status']
  );
  assert.deepEqual(calls[0].options, { chatId: '6314031751' });
});

test('handleLocalInputLine accepts Dutch sessions alias', async () => {
  const config = {
    get claudeArgs() {
      return [];
    },
    get codexArgs() {
      return [];
    },
    get claudeLastSessionId() {
      return null;
    },
    get codexLastSessionId() {
      return null;
    },
    get telegramChatId() {
      return 'chat-1';
    },
    get telegramBotUsername() {
      return 'RegelneefBot';
    },
    set() {},
    setMany() {},
    clearPairing() {},
  };
  const bridge = new Bridge(config, 'claude', []);
  bridge.running = true;
  let showSessionPickerCalls = 0;
  bridge.showSessionPicker = async () => {
    showSessionPickerCalls += 1;
  };
  bridge.writeCliLine = message => {
    throw new Error(`Expected /sessies local command to open picker, got: ${message}`);
  };

  await bridge.handleLocalInputLine('/sessies');

  assert.equal(showSessionPickerCalls, 1);
});

test('pollOnce uses short Telegram polling timeout for responsive commands', async () => {
  const data = {
    telegramUpdateCursor: 100,
  };
  const config = {
    get claudeArgs() {
      return [];
    },
    get codexArgs() {
      return [];
    },
    get claudeLastSessionId() {
      return null;
    },
    get codexLastSessionId() {
      return null;
    },
    get telegramChatId() {
      return 'chat-1';
    },
    get telegramChatUserId() {
      return null;
    },
    get telegramUpdateCursor() {
      return data.telegramUpdateCursor;
    },
    get telegramBotUsername() {
      return 'RegelneefBot';
    },
    set(key, value) {
      data[key] = value;
    },
    setMany() {},
    clearPairing() {},
  };
  const getUpdatesCalls = [];
  const bridge = new Bridge(config, 'claude', []);
  bridge.logCliEvent = () => {};
  bridge.telegram = {
    async getUpdates(cursor, timeout) {
      getUpdatesCalls.push({ cursor, timeout });
      return { messages: [], nextCursor: cursor };
    },
  };

  await bridge.pollOnce();

  assert.deepEqual(getUpdatesCalls, [{ cursor: 100, timeout: 2 }]);
});
