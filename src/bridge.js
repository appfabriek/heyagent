import crypto from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import readlinePromises from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { select } from '@inquirer/prompts';
import qrcode from 'qrcode-terminal';
import Logger from './logger.js';
import { TelegramApi, TelegramApiError } from './telegram-api.js';
import { createOnboardingSession } from './token-web-intake.js';
import { runClaudePrompt } from './providers/claude-provider.js';
import { runCodexPrompt } from './providers/codex-provider.js';
import { runGrokPrompt } from './providers/grok-provider.js';
import { applyDefaultBypassArgs } from './args.js';
import { formatSleepInhibitorStatus, startSleepInhibitor } from './sleep-inhibitor.js';
import { gatherSessions } from './sessions.js';
import {
  VOICE_SESSION_LIST_LIMIT,
  findProjectGroup,
  formatAmbiguousProjectsPrompt,
  formatUnknownProjectPrompt,
  formatVoiceProjectPrompt,
  isVoicePickerCancel,
  parseProjectNavigationIntent,
  parseSessionChoice,
} from './voice-session-picker.js';
import { createVoiceTranscriber, formatVoiceTranscriberStatus } from './voice-transcriber.js';

const BOTFATHER_URL = 'https://t.me/BotFather';
const SETUP_MODE_PHONE = 'phone_onboarding';
const SETUP_MODE_MANUAL = 'manual_fallback';
const ATTACHMENT_DOWNLOAD_DIR = path.join(os.tmpdir(), 'heyagent-files');
const VOICE_NOTE_HINT_TEXT =
  'Hint: send a Telegram voice note for hands-free input (transcribed locally with Whisper).';
const VOICE_TRANSCRIPTION_UNAVAILABLE_TEXT =
  'Voice transcription is unavailable. Install ffmpeg and whisper-cli (e.g. brew install ffmpeg whisper-cpp), or type your message instead.';
const SESSION_PICKER_LIMIT = 20;
const RECENT_SESSION_PICKER_LIMIT = 10;
const SESSION_BUTTON_MAX_LENGTH = 64;
const TELEGRAM_POLL_TIMEOUT_SECONDS = 2;
const PROVIDER_ORDER = ['claude', 'codex', 'grok'];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function promptLine(question) {
  const rl = readlinePromises.createInterface({ input, output });
  try {
    const answer = await rl.question(question);
    return String(answer || '').trim();
  } finally {
    rl.close();
  }
}

function getCurrentSessionId(config, provider) {
  if (provider === 'codex') {
    return config.codexLastSessionId || null;
  }
  if (provider === 'claude') {
    return config.claudeLastSessionId || null;
  }
  if (provider === 'grok') {
    return config.grokLastSessionId || null;
  }
  return null;
}

function splitArgs(raw) {
  return String(raw || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function formatProviderName(provider) {
  if (provider === 'claude') {
    return 'Claude';
  }
  if (provider === 'codex') {
    return 'Codex';
  }
  if (provider === 'grok') {
    return 'Grok';
  }
  return String(provider || 'Provider');
}

function normalizeProviderList(providers, fallback = PROVIDER_ORDER) {
  const values = new Set(Array.isArray(providers) ? providers : []);
  const normalized = PROVIDER_ORDER.filter(provider => values.has(provider));
  if (normalized.length > 0) {
    return normalized;
  }

  const fallbackValues = new Set(Array.isArray(fallback) ? fallback : []);
  return PROVIDER_ORDER.filter(provider => fallbackValues.has(provider));
}

function getSessionProviders(sessions) {
  const providers = new Set();
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (session?.agentType === 'claude' || session?.agentType === 'codex' || session?.agentType === 'grok') {
      providers.add(session.agentType);
    }
  }
  return PROVIDER_ORDER.filter(provider => providers.has(provider));
}

function resolveVisibleProviders(sessions, fallbackProvider = 'codex') {
  const sessionProviders = getSessionProviders(sessions);
  if (sessionProviders.length > 0) {
    return sessionProviders;
  }
  return normalizeProviderList([fallbackProvider], PROVIDER_ORDER);
}

function createTelegramBotCommands(visibleProviders = PROVIDER_ORDER) {
  const providers = new Set(normalizeProviderList(visibleProviders, PROVIDER_ORDER));
  return [
    { command: 'help', description: 'Show command list' },
    { command: 'new', description: 'Start a fresh session' },
    { command: 'stop', description: 'Stop current execution' },
    providers.has('claude') ? { command: 'claude', description: 'Switch to Claude' } : null,
    providers.has('codex') ? { command: 'codex', description: 'Switch to Codex' } : null,
    providers.has('grok') ? { command: 'grok', description: 'Switch to Grok' } : null,
    { command: 'projects', description: 'Choose project' },
    { command: 'sessions', description: 'Choose session' },
    { command: 'status', description: 'Show current status' },
  ].filter(Boolean);
}

function truncateLabel(text, maxLength = SESSION_BUTTON_MAX_LENGTH) {
  const value = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function formatSessionButtonLabel(session) {
  const provider = formatProviderName(session?.agentType || 'provider');
  const title = String(session?.title || session?.lastUserMessage || session?.id || 'Untitled session')
    .replace(/\s+/g, ' ')
    .trim();

  return truncateLabel(`${title} (${provider})`);
}

function normalizeProjectName(project) {
  return String(project || 'unknown').trim() || 'unknown';
}

function normalizeCommandName(command) {
  return String(command || '')
    .toLowerCase()
    .split('@')[0];
}

function groupSessionsByProject(sessions, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(0, Number(options.limit)) : Infinity;
  const groupsByProject = new Map();

  for (const session of (Array.isArray(sessions) ? sessions : []).slice(0, limit)) {
    const project = normalizeProjectName(session?.project);
    if (!groupsByProject.has(project)) {
      groupsByProject.set(project, {
        project,
        cwd: session?.cwd || null,
        sessions: [],
      });
    }
    groupsByProject.get(project).sessions.push(session);
  }

  return [...groupsByProject.values()];
}

function formatProjectButtonLabel(group) {
  const sessions = Array.isArray(group?.sessions) ? group.sessions : [];
  const project = normalizeProjectName(group?.project || sessions[0]?.project);

  return truncateLabel(`${project} (${sessions.length})`);
}

function createSessionKeyboard(sessions, registerToken, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(0, Number(options.limit)) : SESSION_PICKER_LIMIT;
  const rows = [];

  for (const session of (Array.isArray(sessions) ? sessions : []).slice(0, limit)) {
    const token = registerToken(session);
    rows.push([
      {
        text: formatSessionButtonLabel(session),
        callback_data: token,
      },
    ]);
  }

  return {
    inline_keyboard: rows,
  };
}

function createSessionProjectKeyboard(sessions, registerProjectToken, options = {}) {
  const rows = [];

  for (const group of groupSessionsByProject(sessions, options)) {
    rows.push([
      {
        text: formatProjectButtonLabel(group),
        callback_data: registerProjectToken(group),
      },
    ]);
  }

  return {
    inline_keyboard: rows,
  };
}

function createProjectSessionKeyboard(group, registerSessionToken, registerNewSessionToken, options = {}) {
  const sessions = Array.isArray(group?.sessions) ? group.sessions : [];
  const project = normalizeProjectName(group?.project || sessions[0]?.project);
  const cwd = group?.cwd || sessions.find(session => session?.cwd)?.cwd || null;
  const limit = Number.isFinite(options.limit) ? Math.max(0, Number(options.limit)) : SESSION_PICKER_LIMIT;
  const visibleProviders = new Set(normalizeProviderList(options.visibleProviders || PROVIDER_ORDER, PROVIDER_ORDER));
  const projectProviders = getSessionProviders(sessions).filter(provider => visibleProviders.has(provider));
  const rows = [];

  if (projectProviders.length > 0 && typeof registerNewSessionToken === 'function') {
    rows.push(
      projectProviders.map(provider => ({
        text: `New ${formatProviderName(provider)}`,
        callback_data: registerNewSessionToken({
          provider,
          project,
          cwd,
        }),
      }))
    );
  }

  for (const session of sessions.slice(0, limit)) {
    rows.push([
      {
        text: formatSessionButtonLabel(session),
        callback_data: registerSessionToken(session),
      },
    ]);
  }

  return {
    inline_keyboard: rows,
  };
}

function makePairCode() {
  while (true) {
    const code = crypto
      .randomBytes(8)
      .toString('base64url')
      .replace(/[^a-zA-Z0-9]/g, '');
    if (code.length >= 10) {
      return code.slice(0, 10).toLowerCase();
    }
  }
}

function buildStatusText(
  config,
  provider,
  providerArgs = [],
  sleepInhibitorState = null,
  selectedSessionCwd = null,
  voiceTranscriberState = null
) {
  const bot = config.telegramBotUsername ? `@${config.telegramBotUsername}` : 'not set';
  const sessionId = getCurrentSessionId(config, provider);
  const argsText = Array.isArray(providerArgs) && providerArgs.length > 0 ? providerArgs.join(' ') : '(none)';
  const sleepStatus = formatSleepInhibitorStatus(sleepInhibitorState);
  const voiceStatus = formatVoiceTranscriberStatus(voiceTranscriberState);
  return [
    `Provider: ${provider}`,
    `Args: ${argsText}`,
    `Sleep prevention: ${sleepStatus}`,
    `Voice transcription: ${voiceStatus}`,
    `Directory: ${process.cwd()}`,
    selectedSessionCwd ? `Selected session directory: ${selectedSessionCwd}` : null,
    `Bot: ${bot}`,
    `Chat: ${config.telegramChatId || 'not paired'}`,
    `Session: ${sessionId || '-'}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function isPairStartMessage(text, code) {
  const match = String(text || '')
    .trim()
    .match(/^\/start(?:@\w+)?(?:\s+(.+))?$/i);

  if (!match) {
    return false;
  }

  const payload = String(match[1] || '').trim();
  return payload === `ha2_${code}`;
}

function printManualTokenSetupHelp() {
  console.log('\nManual setup (fallback, no tunnel):');
  console.log('Open BotFather with this QR/link:\n');
  qrcode.generate(BOTFATHER_URL, { small: true });
  console.log(`Link: ${BOTFATHER_URL}\n`);
  console.log('Steps:');
  console.log('1. Run /newbot (or /token for an existing bot)');
  console.log('2. Copy the HTTP API token');
  console.log('3. Paste token here in terminal\n');
}

function toLogPreview(text) {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return '(empty)';
  }

  const singleLine = normalized.replace(/\s+/g, ' ');
  if (singleLine.length <= 240) {
    return singleLine;
  }

  return `${singleLine.slice(0, 239)}…`;
}

class Bridge {
  constructor(config, provider, providerArgs = [], options = {}) {
    this.config = config;
    this.provider = provider;
    this.providerArgs = providerArgs;
    this.initialSessionId = String(options.initialSessionId || '').trim() || null;
    this.startMode = options.startMode === 'new' ? 'new' : options.startMode === 'resume' ? 'resume' : 'auto';
    this.forceNewNextPrompt = this.startMode === 'new';
    this.logger = new Logger('bridge');
    this.telegram = null;
    this.sleepInhibitorState = null;
    this.running = true;
    this.manualHelpShown = false;
    this.localInputInterface = null;
    this.localInputQueue = Promise.resolve();
    this.promptQueue = Promise.resolve();
    this.activePromptAbortController = null;
    this.activePromptSource = null;
    this.activePromptAbortReason = null;
    this.telegramPendingMessages = [];
    this.telegramDispatchScheduled = false;
    this.gatherSessions = typeof options.gatherSessions === 'function' ? options.gatherSessions : gatherSessions;
    this.visibleProviders = null;
    this.sessionPickerEntries = new Map();
    this.sessionPickerProjectEntries = new Map();
    this.newSessionProjectEntries = new Map();
    this.sessionPickerCounter = 0;
    this.selectedSessionCwd = null;
    this.voiceSessionPickerState = null;
    this.voiceTranscriberState = null;

    this.onSignal = () => {
      this.requestStopCurrentPrompt('shutdown');
      this.clearQueuedTelegramMessages();
      this.running = false;
      this.stopLocalInputLoop();
      console.log('\nStopping HeyAgent...');
    };
  }

  async start() {
    process.on('SIGINT', this.onSignal);
    process.on('SIGTERM', this.onSignal);

    try {
      this.sleepInhibitorState = startSleepInhibitor({ logger: this.logger });

      if (this.sleepInhibitorState.active) {
        console.log(`Sleep prevention active (${this.sleepInhibitorState.backend}).`);
      } else {
        console.log(`Sleep prevention unavailable: ${this.sleepInhibitorState.reason || 'unknown error'}.`);
      }

      await mkdir(ATTACHMENT_DOWNLOAD_DIR, { recursive: true });

      this.voiceTranscriberState = await createVoiceTranscriber();
      console.log(`Voice transcription: ${formatVoiceTranscriberStatus(this.voiceTranscriberState)}.`);

      const pairing = await this.ensureBridgeReady();
      this.config.setMany({
        provider: this.provider,
        telegramChatId: pairing.chatId,
      });
      if (this.initialSessionId) {
        this.setBoundSessionId(this.initialSessionId);
        this.forceNewNextPrompt = false;
      } else {
        this.setBoundSessionId(null);
      }

      console.log(`Connected to Telegram chat ${pairing.chatId}.`);
      console.log(`HeyAgent is running in ${this.provider} mode. Send /help in Telegram.\n`);

      const providerLabel = formatProviderName(this.provider);
      const startupHeadline =
        this.startMode === 'new'
          ? `HeyAgent connected. Next message starts a new ${providerLabel} session.`
          : this.initialSessionId
            ? `HeyAgent connected to ${providerLabel} session ${this.initialSessionId}.`
            : `HeyAgent connected to your last ${providerLabel} session for the current folder: ${process.cwd()}`;

      await this.safeSendMessage([startupHeadline, 'Send /help for available commands.', VOICE_NOTE_HINT_TEXT].join('\n\n'));

      this.startLocalInputLoop();

      while (this.running) {
        await this.pollOnce();
      }
    } finally {
      this.stopLocalInputLoop();
      if (this.sleepInhibitorState && typeof this.sleepInhibitorState.stop === 'function') {
        await this.sleepInhibitorState.stop();
      }
      process.off('SIGINT', this.onSignal);
      process.off('SIGTERM', this.onSignal);
    }
  }

  writeCliLine(line) {
    const message = String(line || '');
    if (this.localInputInterface) {
      output.write(`\n${message}\n`);
      if (this.running) {
        this.localInputInterface.prompt();
      }
      return;
    }

    console.log(message);
  }

  logCliEvent(label, text = '') {
    const timestamp = new Date().toLocaleTimeString();
    const suffix = text ? `: ${toLogPreview(text)}` : '';
    this.writeCliLine(`[${timestamp}] ${label}${suffix}`);
  }

  getBoundSessionId() {
    return getCurrentSessionId(this.config, this.provider);
  }

  setBoundSessionId(sessionId) {
    const normalized = String(sessionId || '').trim() || null;
    if (this.provider === 'codex') {
      this.config.set('codexLastSessionId', normalized);
      return;
    }
    if (this.provider === 'claude') {
      this.config.set('claudeLastSessionId', normalized);
    }
    if (this.provider === 'grok') {
      this.config.set('grokLastSessionId', normalized);
    }
  }

  switchProvider(provider) {
    if (provider !== 'claude' && provider !== 'codex' && provider !== 'grok') {
      throw new Error(`Unsupported provider: ${provider}`);
    }

    const rawArgs =
      provider === 'claude' ? this.config.claudeArgs : provider === 'codex' ? this.config.codexArgs : this.config.grokArgs;
    const effective = applyDefaultBypassArgs(provider, rawArgs);

    this.provider = provider;
    this.providerArgs = effective.providerArgs;
    this.config.setMany({
      provider,
      claudeArgs: provider === 'claude' ? effective.providerArgs : this.config.claudeArgs,
      codexArgs: provider === 'codex' ? effective.providerArgs : this.config.codexArgs,
      grokArgs: provider === 'grok' ? effective.providerArgs : this.config.grokArgs,
    });

    return effective;
  }

  async handleProviderSwitchCommand(provider, rawArgs = '', source = 'telegram') {
    const sourceLabel = source === 'cli' ? 'CLI' : 'Telegram';
    const args = splitArgs(rawArgs);
    const effective = this.switchProvider(provider);
    this.selectedSessionCwd = null;
    const sessionId = this.getBoundSessionId() || '-';
    const argsText = effective.providerArgs.length > 0 ? effective.providerArgs.join(' ') : '(none)';

    this.logCliEvent(`${sourceLabel} provider switch`, provider);

    await this.safeSendMessage(
      [
        `Provider switched to ${provider}.`,
        `Session: ${sessionId}`,
        `Args: ${argsText}`,
        args.length > 0 ? 'Inline switch args are ignored. Use startup args to set defaults.' : null,
        effective.defaultBypassApplied ? 'Default bypass mode applied.' : null,
      ]
        .filter(Boolean)
        .join('\n')
    );
  }

  startLocalInputLoop() {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      return;
    }

    if (this.localInputInterface) {
      return;
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      historySize: 1000,
    });

    this.localInputInterface = rl;
    this.writeCliLine('Local CLI input enabled. Type /help for local commands, or type a prompt directly.');
    rl.setPrompt('hey> ');
    rl.prompt();

    rl.on('line', line => {
      const value = String(line || '').trim();
      this.localInputQueue = this.localInputQueue
        .then(() => this.handleLocalInputLine(value))
        .catch(error => {
          this.logCliEvent('Local input error', error.message || String(error));
        })
        .finally(() => {
          if (this.running && this.localInputInterface) {
            this.localInputInterface.prompt();
          }
        });
    });

    rl.on('close', () => {
      this.localInputInterface = null;
    });
  }

  stopLocalInputLoop() {
    if (!this.localInputInterface) {
      return;
    }

    try {
      this.localInputInterface.close();
    } catch {
      // Ignore close failures.
    }

    this.localInputInterface = null;
  }

  async handleLocalInputLine(inputLine) {
    if (!this.running) {
      return;
    }

    const line = String(inputLine || '').trim();
    if (!line) {
      return;
    }

    if (line === '/help') {
      this.writeCliLine(
        [
          'Local CLI commands:',
          '/help - show this list',
          '/status - show current status',
          '/new - reset session (next prompt starts fresh)',
          '/stop - stop current execution and clear queued Telegram messages',
          '/claude - switch to Claude provider',
          '/codex - switch to Codex provider',
          '/grok - switch to Grok provider',
          '/projects - choose a project, then continue or start a session',
          '/sessions or /sessies - choose one of the 10 most recent sessions in Telegram',
          'ga naar project <naam> - voice-friendly numbered session picker',
          '/say <text> - send a raw message to Telegram',
          '/ask <prompt> - run prompt through provider and send response to Telegram',
          '/exit - stop HeyAgent',
          '',
          'Any plain text line is treated as /ask <line>.',
        ].join('\n')
      );
      return;
    }

    if (line === '/status') {
      this.writeCliLine(
        buildStatusText(
          this.config,
          this.provider,
          this.providerArgs,
          this.sleepInhibitorState,
          this.selectedSessionCwd,
          this.voiceTranscriberState
        )
      );
      return;
    }

    if (line === '/new') {
      this.resetSessionMode();
      await this.safeSendMessage('Session reset from CLI. Your next message starts fresh.');
      return;
    }

    if (line === '/stop') {
      const stopped = this.requestStopCurrentPrompt('manual_stop');
      const clearedCount = this.clearQueuedTelegramMessages();

      if (stopped) {
        await this.safeSendMessage(`Stopping current ${formatProviderName(this.provider)} request and clearing queued messages...`, { from: 'CLI' });
      } else if (clearedCount > 0) {
        await this.safeSendMessage(`Cleared ${clearedCount} queued Telegram message${clearedCount === 1 ? '' : 's'}.`, { from: 'CLI' });
      } else {
        this.writeCliLine('No active request to stop.');
      }
      return;
    }

    if (line === '/claude' || line.startsWith('/claude ')) {
      const argument = line.slice('/claude'.length).trim();
      await this.handleProviderSwitchCommand('claude', argument, 'cli');
      return;
    }

    if (line === '/codex' || line.startsWith('/codex ')) {
      const argument = line.slice('/codex'.length).trim();
      await this.handleProviderSwitchCommand('codex', argument, 'cli');
      return;
    }

    if (line === '/grok' || line.startsWith('/grok ')) {
      const argument = line.slice('/grok'.length).trim();
      await this.handleProviderSwitchCommand('grok', argument, 'cli');
      return;
    }

    if (line === '/sessions' || line === '/sessies') {
      await this.showSessionPicker();
      return;
    }

    if (line === '/projects' || line === '/projecten') {
      await this.showProjectPicker();
      return;
    }

    if (line === '/exit') {
      this.running = false;
      this.writeCliLine('Stopping HeyAgent...');
      this.stopLocalInputLoop();
      return;
    }

    if (line.startsWith('/say ')) {
      const message = line.slice(5).trim();
      if (!message) {
        this.writeCliLine('Usage: /say <text>');
        return;
      }
      await this.safeSendMessage(message, { from: 'CLI' });
      return;
    }

    if (await this.handleVoiceSessionPickerMessage(line)) {
      return;
    }

    if (line.startsWith('/ask ')) {
      const prompt = line.slice(5).trim();
      if (!prompt) {
        this.writeCliLine('Usage: /ask <prompt>');
        return;
      }
      await this.queuePrompt(prompt, 'cli');
      return;
    }

    if (line.startsWith('/')) {
      this.writeCliLine('Unknown local command. Use /help.');
      return;
    }

    await this.queuePrompt(line, 'cli');
  }

  async ensureBridgeReady() {
    const storedToken = String(this.config.telegramBotToken || '').trim();
    let tokenConnected = false;

    if (storedToken) {
      tokenConnected = await this.connectToken(storedToken);
    }

    if (!tokenConnected) {
      this.config.clearPairing({ keepBotToken: false });
    }

    const needToken = !tokenConnected;
    const needPairing = !this.config.telegramChatId;

    if (!needToken && !needPairing) {
      return {
        chatId: this.config.telegramChatId,
      };
    }

    const setupMode = await this.selectSetupMode();
    if (setupMode === SETUP_MODE_PHONE) {
      return this.runPhoneOnboardingSetup({ needToken, needPairing });
    }

    return this.runManualSetup({ needToken, needPairing });
  }

  async selectSetupMode() {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      return select({
        message: 'Telegram setup mode',
        default: SETUP_MODE_PHONE,
        choices: [
          {
            name: 'Phone setup (recommended) — scan one QR code and complete guided steps on your phone',
            value: SETUP_MODE_PHONE,
          },
          {
            name: 'Manual fallback — no tunnel required; paste the bot token directly into the terminal',
            value: SETUP_MODE_MANUAL,
          },
        ],
      });
    }

    console.log('Interactive setup selection is unavailable in this terminal.');
    console.log('Using manual fallback setup (no tunnel).');
    return SETUP_MODE_MANUAL;
  }

  async runPhoneOnboardingSetup(options = {}) {
    const needToken = Boolean(options.needToken);
    const needPairing = Boolean(options.needPairing);
    let onboarding = null;

    try {
      onboarding = await createOnboardingSession({
        timeoutMs: 20 * 60 * 1000,
        onReady: url => {
          console.log('\nPhone setup (recommended).');
          console.log('Scan this QR code and complete the guided steps on your phone:\n');
          qrcode.generate(url, { small: true });
          console.log(`Link: ${url}\n`);
          console.log('Waiting for onboarding completion...');
        },
      });

      if (needToken) {
        while (this.running) {
          const token = await onboarding.waitForToken();
          const connected = await this.connectToken(token);
          if (connected) {
            onboarding.setTokenValidated({
              botUsername: this.config.telegramBotUsername,
            });
            break;
          }

          onboarding.setTokenInvalid('Telegram rejected this token. Check token and submit again.');
        }
      } else {
        onboarding.setTokenValidated({
          botUsername: this.config.telegramBotUsername,
          preconfigured: true,
        });
      }

      if (!this.running) {
        throw new Error('Setup cancelled');
      }

      let pairing = {
        chatId: this.config.telegramChatId,
      };

      if (needPairing) {
        pairing = await this.runPairingFlow({
          mode: 'onboarding',
          onPairLink: deepLink => onboarding.setPairLink(deepLink),
          onStatus: text => onboarding.setPairingStatus(text),
        });
      } else {
        onboarding.setPairingStatus('Chat already paired on this device.');
      }

      onboarding.markPaired({ chatId: pairing.chatId });
      await sleep(1500);
      return pairing;
    } catch (error) {
      if (onboarding) {
        onboarding.setError(error.message);
      }
      throw error;
    } finally {
      if (onboarding) {
        await onboarding.close();
      }
    }
  }

  async runManualSetup(options = {}) {
    const needToken = Boolean(options.needToken);
    const needPairing = Boolean(options.needPairing);

    if (needToken) {
      while (this.running) {
        if (!this.manualHelpShown) {
          printManualTokenSetupHelp();
          this.manualHelpShown = true;
        }

        const token = await promptLine('Telegram bot token: ');
        if (!token) {
          console.log('Token is required.');
          continue;
        }

        const connected = await this.connectToken(token.trim());
        if (connected) {
          break;
        }
      }
    }

    if (!this.running) {
      throw new Error('Setup cancelled');
    }

    if (needPairing) {
      return this.runPairingFlow({ mode: 'manual' });
    }

    return {
      chatId: this.config.telegramChatId,
    };
  }

  async connectToken(token) {
    const normalizedToken = String(token || '').trim();
    if (!TelegramApi.isLikelyToken(normalizedToken)) {
      console.error('This does not look like a valid Telegram bot token.');
      return false;
    }

    const previousToken = this.config.telegramBotToken;
    const telegram = new TelegramApi(normalizedToken);

    try {
      await telegram.ensurePollingMode();
      const me = await telegram.getMe();

      this.telegram = telegram;

      const tokenChanged = previousToken !== normalizedToken;
      this.config.setMany({
        telegramBotToken: normalizedToken,
        telegramBotUsername: me.username || null,
        telegramBotId: me.id === undefined || me.id === null ? null : String(me.id),
      });

      if (tokenChanged) {
        this.config.clearPairing();
      }

      await this.configureTelegramCommands(telegram);

      return true;
    } catch (error) {
      if (error instanceof TelegramApiError && error.status === 401) {
        console.error('Telegram rejected the token (401 Unauthorized).');
      } else {
        console.error(`Token validation failed: ${error.message}`);
      }
      return false;
    }
  }

  async configureTelegramCommands(telegram = this.telegram) {
    if (!telegram || typeof telegram.setCommands !== 'function') {
      return;
    }

    let commands = createTelegramBotCommands(this.visibleProviders || [this.provider]);
    try {
      const sessions = await this.gatherSessions();
      this.visibleProviders = resolveVisibleProviders(sessions, this.provider);
      commands = createTelegramBotCommands(this.visibleProviders);
    } catch (error) {
      this.logger.warn(`Failed to inspect local sessions for Telegram commands: ${error.message}`);
    }

    try {
      await telegram.setCommands(commands, { chatId: this.config.telegramChatId });
    } catch (error) {
      this.logger.warn(`Failed to configure Telegram bot commands: ${error.message}`);
    }
  }

  resetSessionMode() {
    const updates = {};

    if (this.provider === 'codex') {
      updates.codexLastSessionId = null;
    }
    if (this.provider === 'claude') {
      updates.claudeLastSessionId = null;
    }
    if (this.provider === 'grok') {
      updates.grokLastSessionId = null;
    }

    this.forceNewNextPrompt = true;
    this.selectedSessionCwd = null;
    this.config.setMany(updates);
  }

  clearQueuedTelegramMessages() {
    const count = this.telegramPendingMessages.length;
    this.telegramPendingMessages = [];
    return count;
  }

  requestStopCurrentPrompt(reason = 'manual_stop') {
    const controller = this.activePromptAbortController;
    if (!controller || controller.signal.aborted) {
      return false;
    }

    this.activePromptAbortReason = reason;
    controller.abort();
    return true;
  }

  isPromptAbortError(error) {
    const message = error?.message ? String(error.message) : String(error || '');
    return /aborted/i.test(message);
  }

  startTelegramDispatch(groupAll = false) {
    if (!this.running) {
      return;
    }

    if (this.telegramDispatchScheduled) {
      return;
    }

    if (this.activePromptAbortController) {
      return;
    }

    if (this.telegramPendingMessages.length === 0) {
      return;
    }

    const pending = groupAll ? this.telegramPendingMessages.splice(0) : [this.telegramPendingMessages.shift()];
    const combinedPrompt = pending.join('\n').trim();
    if (!combinedPrompt) {
      return;
    }

    this.telegramDispatchScheduled = true;
    this.queuePrompt(combinedPrompt, 'telegram', {
      groupedCount: pending.length,
    })
      .catch(error => {
        this.logger.error(`Failed to process grouped Telegram messages: ${error.message}`);
      })
      .finally(() => {
        this.telegramDispatchScheduled = false;
        if (this.telegramPendingMessages.length > 0) {
          this.startTelegramDispatch(true);
        }
      });
  }

  async enqueueTelegramPrompt(text) {
    const cleanText = String(text || '').trim();
    if (!cleanText) {
      return;
    }

    this.telegramPendingMessages.push(cleanText);

    if (this.activePromptAbortController || this.telegramDispatchScheduled) {
      return;
    }

    this.startTelegramDispatch(false);
  }

  async queuePrompt(prompt, source, options = {}) {
    const cleanPrompt = String(prompt || '').trim();
    if (!cleanPrompt) {
      return;
    }

    const run = async () => {
      const sourceLabel = source === 'cli' ? 'CLI' : 'Telegram';
      const providerLabel = formatProviderName(this.provider);
      const resume = !this.forceNewNextPrompt;
      const abortController = new globalThis.AbortController();
      const groupedCount = Number.isFinite(options.groupedCount) ? Math.max(1, Number(options.groupedCount)) : 1;
      this.logCliEvent(`${sourceLabel} -> ${providerLabel}`, cleanPrompt);
      this.activePromptAbortController = abortController;
      this.activePromptSource = source;
      this.activePromptAbortReason = null;

      try {
        if (source === 'telegram') {
          if (groupedCount > 1) {
            await this.safeSendMessage(`${providerLabel} is working on ${groupedCount} messages...`);
          } else {
            await this.safeSendMessage(`${providerLabel} is working...`);
          }
        }

        const response = await this.runProvider(cleanPrompt, resume, {
          abortSignal: abortController.signal,
        });

        this.forceNewNextPrompt = false;
        await this.safeSendMessage(response, { from: providerLabel });
      } catch (error) {
        if (abortController.signal.aborted || this.isPromptAbortError(error)) {
          return;
        }

        await this.safeSendMessage(`Error: ${error.message}`);
        this.logger.error(`Provider execution failed: ${error.message}`);
      } finally {
        if (this.activePromptAbortController === abortController) {
          this.activePromptAbortController = null;
          this.activePromptSource = null;
          this.activePromptAbortReason = null;
        }

        if (this.telegramPendingMessages.length > 0 && !this.telegramDispatchScheduled) {
          this.startTelegramDispatch(true);
        }
      }
    };

    this.promptQueue = this.promptQueue.then(run, run);
    await this.promptQueue;
  }

  async runPairingFlow(options = {}) {
    const mode = options.mode || 'manual';
    const onPairLink = typeof options.onPairLink === 'function' ? options.onPairLink : null;
    const onStatus = typeof options.onStatus === 'function' ? options.onStatus : null;

    const botUsername = this.config.telegramBotUsername;
    if (!botUsername) {
      throw new Error('Telegram bot username is unavailable. Create a bot with @BotFather first.');
    }

    const code = makePairCode();
    const deepLink = `https://t.me/${botUsername}?start=ha2_${code}`;

    if (mode === 'manual') {
      console.log('\nTelegram pairing is required (manual fallback).');
      console.log('1. Scan this QR code or open the link');
      console.log('2. Press START in Telegram');
      console.log('3. Keep this terminal open until pairing completes\n');
      qrcode.generate(deepLink, { small: true });
      console.log(`Link: ${deepLink}`);
      console.log('If needed, open your bot manually and press START.\n');
      console.log('Waiting for Telegram pairing...');
    } else {
      if (onPairLink) {
        onPairLink(deepLink);
      }
      if (onStatus) {
        onStatus('Open bot chat and press START. Waiting for Telegram pairing...');
      }
      console.log('\nWaiting for Telegram pairing from phone onboarding...');
    }

    let cursor = this.config.telegramUpdateCursor || 0;

    while (this.running) {
      try {
        const result = await this.telegram.getUpdates(cursor, 20);
        const nextCursor = Number.isFinite(result.nextCursor) ? result.nextCursor : cursor;
        if (nextCursor > cursor) {
          cursor = nextCursor;
          this.config.set('telegramUpdateCursor', cursor);
        }

        for (const message of result.messages) {
          if (message.chatType !== 'private') {
            continue;
          }

          if (!isPairStartMessage(message.text, code)) {
            continue;
          }

          if (!message.chatId) {
            continue;
          }

          this.config.setMany({
            telegramChatId: message.chatId,
            telegramChatUserId: message.userId || null,
          });

          if (onStatus) {
            onStatus(`Paired successfully (chat ${message.chatId}).`);
          }

          await this.telegram.sendMessage(message.chatId, `HeyAgent paired for ${this.provider}.\nSend /help for commands.`);

          return {
            chatId: message.chatId,
          };
        }
      } catch (error) {
        if (error instanceof TelegramApiError && error.status === 401) {
          this.config.clearPairing({ keepBotToken: false });
          if (onStatus) {
            onStatus('Telegram token became invalid. Restart setup.');
          }
          throw new Error('Telegram bot token is invalid. Restart and enter a new token.');
        }

        this.logger.warn(`Pair poll failed: ${error.message}`);
        await sleep(2000);
      }
    }

    throw new Error('Pairing cancelled');
  }

  registerSessionPickerEntry(session) {
    const tokenNonce = crypto
      .randomBytes(4)
      .toString('base64url')
      .replace(/[^a-zA-Z0-9_-]/g, '');
    const token = `sess_${Date.now().toString(36)}_${this.sessionPickerCounter.toString(36)}_${tokenNonce}`;
    this.sessionPickerCounter += 1;
    this.sessionPickerEntries.set(token, session);
    return token;
  }

  registerSessionPickerProject(group) {
    const tokenNonce = crypto
      .randomBytes(4)
      .toString('base64url')
      .replace(/[^a-zA-Z0-9_-]/g, '');
    const token = `proj_${Date.now().toString(36)}_${this.sessionPickerCounter.toString(36)}_${tokenNonce}`;
    this.sessionPickerCounter += 1;
    this.sessionPickerProjectEntries.set(token, group);
    return token;
  }

  registerNewSessionProject(entry) {
    const tokenNonce = crypto
      .randomBytes(4)
      .toString('base64url')
      .replace(/[^a-zA-Z0-9_-]/g, '');
    const token = `new_${Date.now().toString(36)}_${this.sessionPickerCounter.toString(36)}_${tokenNonce}`;
    this.sessionPickerCounter += 1;
    this.newSessionProjectEntries.set(token, entry);
    return token;
  }

  async showSessionPicker() {
    this.logCliEvent('Session picker', 'loading latest Claude, Codex, and Grok sessions');
    const sessions = await this.gatherSessions();
    this.visibleProviders = resolveVisibleProviders(sessions, this.provider);
    const recentSessions = sessions.slice(0, RECENT_SESSION_PICKER_LIMIT);

    if (recentSessions.length === 0) {
      await this.safeSendMessage('Geen Claude-, Codex- of Grok-sessies gevonden.');
      return;
    }

    this.sessionPickerEntries.clear();
    this.sessionPickerProjectEntries.clear();
    this.newSessionProjectEntries.clear();
    const replyMarkup = createSessionKeyboard(recentSessions, session => this.registerSessionPickerEntry(session), {
      limit: RECENT_SESSION_PICKER_LIMIT,
    });
    await this.safeSendMessage(`Kies een sessie (${recentSessions.length} meest recent):`, {
      replyMarkup,
    });
  }

  async showProjectPicker() {
    this.logCliEvent('Project picker', 'loading Claude, Codex, and Grok projects');
    const sessions = await this.gatherSessions();
    this.visibleProviders = resolveVisibleProviders(sessions, this.provider);
    const groups = groupSessionsByProject(sessions);

    if (groups.length === 0) {
      await this.safeSendMessage('Geen Claude-, Codex- of Grok-projecten gevonden.');
      return;
    }

    this.sessionPickerEntries.clear();
    this.sessionPickerProjectEntries.clear();
    this.newSessionProjectEntries.clear();
    const replyMarkup = createSessionProjectKeyboard(sessions, group => this.registerSessionPickerProject(group));
    const projectSuffix = groups.length === 1 ? 'project' : 'projecten';
    await this.safeSendMessage(`Kies een project (${groups.length} ${projectSuffix}):`, {
      replyMarkup,
    });
  }

  async answerCallback(callbackQueryId, text = '') {
    if (!this.telegram || !callbackQueryId) {
      return;
    }

    try {
      await this.telegram.answerCallbackQuery(callbackQueryId, text);
    } catch (error) {
      this.logger.warn(`Failed to answer Telegram callback: ${error.message}`);
    }
  }

  async handleCallback(callback) {
    const data = String(callback?.data || '').trim();
    if (data.startsWith('proj_')) {
      await this.handleSessionProjectCallback(callback);
      return;
    }

    if (data.startsWith('new_')) {
      await this.handleNewSessionCallback(callback);
      return;
    }

    if (!data.startsWith('sess_')) {
      await this.answerCallback(callback.callbackQueryId);
      return;
    }

    await this.handleSessionPickerCallback(callback);
  }

  async handleSessionProjectCallback(callback) {
    const token = String(callback?.data || '').trim();
    const group = this.sessionPickerProjectEntries.get(token);

    if (!group) {
      await this.answerCallback(callback.callbackQueryId, 'Project verlopen');
      await this.safeSendMessage('Deze projectkeuze is verlopen. Stuur opnieuw /projects.');
      return;
    }

    const sessions = Array.isArray(group.sessions) ? group.sessions : [];
    if (sessions.length === 0) {
      await this.answerCallback(callback.callbackQueryId, 'Geen sessies');
      await this.safeSendMessage('Geen sessies gevonden voor dit project. Stuur opnieuw /projects.');
      return;
    }

    this.sessionPickerEntries.clear();
    this.newSessionProjectEntries.clear();
    const project = normalizeProjectName(group.project);
    const visibleProviders = this.visibleProviders || resolveVisibleProviders(sessions, this.provider);
    const replyMarkup = createProjectSessionKeyboard(
      group,
      session => this.registerSessionPickerEntry(session),
      entry => this.registerNewSessionProject(entry),
      {
        visibleProviders,
        limit: SESSION_PICKER_LIMIT,
      }
    );
    await this.answerCallback(callback.callbackQueryId, project);
    await this.safeSendMessage(`Kies een sessie voor ${project}:`, { replyMarkup });
  }

  async handleNewSessionCallback(callback) {
    const token = String(callback?.data || '').trim();
    const entry = this.newSessionProjectEntries.get(token);

    if (!entry) {
      await this.answerCallback(callback.callbackQueryId, 'Keuze verlopen');
      await this.safeSendMessage('Deze nieuwe-sessiekeuze is verlopen. Stuur opnieuw /projects.');
      return;
    }

    if (entry.provider !== 'claude' && entry.provider !== 'codex' && entry.provider !== 'grok') {
      await this.answerCallback(callback.callbackQueryId, 'Onbekende provider');
      await this.safeSendMessage(`Unsupported session provider: ${entry.provider || 'unknown'}`);
      return;
    }

    this.requestStopCurrentPrompt('session_switch');
    this.clearQueuedTelegramMessages();
    this.switchProvider(entry.provider);
    this.setBoundSessionId(null);
    this.selectedSessionCwd = entry.cwd || null;
    this.forceNewNextPrompt = true;
    this.newSessionProjectEntries.delete(token);

    const providerLabel = formatProviderName(entry.provider);
    const project = normalizeProjectName(entry.project);
    await this.answerCallback(callback.callbackQueryId, `New ${providerLabel}`);
    await this.safeSendMessage(
      [
        `New ${providerLabel} session selected.`,
        `Project: ${project}`,
        entry.cwd ? `Directory: ${entry.cwd}` : null,
        'Your next message starts a fresh session.',
      ]
        .filter(Boolean)
        .join('\n')
    );
  }

  clearVoiceSessionPickerState() {
    this.voiceSessionPickerState = null;
  }

  async applySelectedSession(session, options = {}) {
    if (!session) {
      return false;
    }

    if (session.agentType !== 'claude' && session.agentType !== 'codex' && session.agentType !== 'grok') {
      await this.safeSendMessage(`Unsupported session provider: ${session.agentType || 'unknown'}`, options);
      return false;
    }

    this.requestStopCurrentPrompt('session_switch');
    this.clearQueuedTelegramMessages();
    this.switchProvider(session.agentType);
    this.setBoundSessionId(session.id);
    this.selectedSessionCwd = session.cwd || null;
    this.forceNewNextPrompt = false;
    this.clearVoiceSessionPickerState();

    const providerLabel = formatProviderName(session.agentType);
    const project = session.project || 'unknown';
    const title = session.title || session.lastUserMessage || session.id;
    await this.safeSendMessage(
      [`${providerLabel}-sessie geselecteerd.`, `Project: ${project}`, title ? `Titel: ${title}` : null, 'Je volgende bericht gaat verder in deze sessie.']
        .filter(Boolean)
        .join('\n'),
      options
    );
    return true;
  }

  async startVoiceProjectPicker(projectQuery) {
    const sessions = await this.gatherSessions();
    const groups = groupSessionsByProject(sessions);
    const { group, ambiguous } = findProjectGroup(groups, projectQuery);

    if (ambiguous.length > 0) {
      await this.safeSendMessage(formatAmbiguousProjectsPrompt(ambiguous));
      return true;
    }

    if (!group) {
      await this.safeSendMessage(formatUnknownProjectPrompt(projectQuery, groups));
      return true;
    }

    const projectSessions = Array.isArray(group.sessions) ? group.sessions.slice(0, VOICE_SESSION_LIST_LIMIT) : [];
    this.voiceSessionPickerState = {
      project: normalizeProjectName(group.project),
      cwd: group.cwd || projectSessions.find(session => session?.cwd)?.cwd || null,
      sessions: projectSessions,
    };

    await this.safeSendMessage(formatVoiceProjectPrompt(this.voiceSessionPickerState.project, projectSessions));
    return true;
  }

  async handleVoiceSessionPickerMessage(text) {
    if (isVoicePickerCancel(text)) {
      this.clearVoiceSessionPickerState();
      await this.safeSendMessage('Sessiekeuze geannuleerd.');
      return true;
    }

    if (this.voiceSessionPickerState) {
      const choice = parseSessionChoice(text, this.voiceSessionPickerState.sessions.length);
      if (choice === 'new') {
        this.requestStopCurrentPrompt('session_switch');
        this.clearQueuedTelegramMessages();
        this.setBoundSessionId(null);
        this.selectedSessionCwd = this.voiceSessionPickerState.cwd || null;
        this.forceNewNextPrompt = true;
        const project = this.voiceSessionPickerState.project;
        this.clearVoiceSessionPickerState();
        await this.safeSendMessage(`Nieuwe ${formatProviderName(this.provider)}-sessie voor ${project}. Je volgende bericht start vers.`);
        return true;
      }

      if (Number.isInteger(choice)) {
        const session = this.voiceSessionPickerState.sessions[choice - 1];
        if (!session) {
          await this.safeSendMessage(`Kies een nummer tussen 1 en ${this.voiceSessionPickerState.sessions.length}.`);
          return true;
        }

        await this.applySelectedSession(session);
        return true;
      }
    }

    const projectQuery = parseProjectNavigationIntent(text);
    if (projectQuery) {
      await this.startVoiceProjectPicker(projectQuery);
      return true;
    }

    return false;
  }

  async handleSessionPickerCallback(callback) {
    const token = String(callback?.data || '').trim();
    const session = this.sessionPickerEntries.get(token);

    if (!session) {
      await this.answerCallback(callback.callbackQueryId, 'Sessie verlopen');
      await this.safeSendMessage('Deze sessiekeuze is verlopen. Stuur opnieuw /sessions.');
      return;
    }

    this.sessionPickerEntries.delete(token);
    await this.answerCallback(callback.callbackQueryId, `${formatProviderName(session.agentType)} geselecteerd`);
    await this.applySelectedSession(session);
  }

  async pollOnce() {
    const chatId = this.config.telegramChatId;
    const chatUserId = this.config.telegramChatUserId;
    const cursor = this.config.telegramUpdateCursor || 0;

    if (!chatId) {
      throw new Error('No Telegram chat is paired. Run `hey reset` then start again.');
    }

    try {
      const result = await this.telegram.getUpdates(cursor, TELEGRAM_POLL_TIMEOUT_SECONDS);
      const nextCursor = Number.isFinite(result.nextCursor) ? result.nextCursor : cursor;
      if (nextCursor > cursor) {
        this.config.set('telegramUpdateCursor', nextCursor);
      }

      for (const message of result.messages) {
        if (!this.running) {
          break;
        }

        if (message.chatId !== chatId) {
          continue;
        }

        if (chatUserId && message.userId && message.userId !== chatUserId) {
          continue;
        }

        if (message.type === 'callback') {
          await this.handleCallback(message);
          continue;
        }

        if (message.text && message.text.trim().startsWith('/')) {
          this.logCliEvent('Telegram command', message.text);
        }

        if (message.fileId) {
          await this.handleAttachmentMessage(message);
          continue;
        }

        await this.handleMessage(message.text || '');
      }
    } catch (error) {
      if (error instanceof TelegramApiError && error.status === 401) {
        this.config.clearPairing({ keepBotToken: false });
        this.running = false;
        throw new Error('Telegram bot token is invalid. Restart and enter a new token.');
      }

      this.logger.error(`Inbox poll failed: ${error.message}`);
      await sleep(2000);
    }
  }

  async handleMessage(rawText) {
    const text = String(rawText || '').trim();
    if (!text) {
      return;
    }

    if (text.startsWith('/')) {
      await this.handleCommand(text);
      return;
    }

    if (await this.handleVoiceSessionPickerMessage(text)) {
      return;
    }

    await this.enqueueTelegramPrompt(text);
  }

  isAudioAttachment(type) {
    return type === 'voice' || type === 'audio';
  }

  buildAttachmentPrompt(message, filePath) {
    const lines = [`The user sent a Telegram ${message.type || 'file'} attachment.`, `Local file path: ${filePath}`];

    if (message.fileName) {
      lines.push(`Original filename: ${message.fileName}`);
    }
    if (message.mimeType) {
      lines.push(`MIME type: ${message.mimeType}`);
    }
    if (Number.isFinite(message.fileSizeBytes) && message.fileSizeBytes > 0) {
      lines.push(`File size bytes: ${message.fileSizeBytes}`);
    }
    if (Number.isFinite(message.durationSec) && message.durationSec > 0) {
      lines.push(`Duration seconds: ${message.durationSec}`);
    }

    const userText = String(message.caption || message.text || '').trim();
    lines.push('');
    if (userText) {
      lines.push(`User message: ${userText}`);
    } else {
      lines.push('User message: (none)');
    }
    lines.push('Please inspect the file and respond to the user.');

    return lines.join('\n');
  }

  async handleVoiceAttachmentMessage(message, fileId) {
    if (!this.voiceTranscriberState?.available) {
      await this.safeSendMessage(VOICE_TRANSCRIPTION_UNAVAILABLE_TEXT);
      return;
    }

    await this.safeSendMessage('Transcribing voice note...');

    try {
      const transcript = await this.voiceTranscriberState.transcribeTelegramVoice(this.telegram, fileId);
      const caption = String(message.caption || message.text || '').trim();
      const promptText = caption ? `${caption}\n\n${transcript}` : transcript;

      this.logCliEvent('Voice transcript', transcript);
      await this.safeSendMessage(`"${transcript}"`);
      await this.handleMessage(promptText);
    } catch (error) {
      const messageText = error?.message ? String(error.message) : String(error);
      this.logger.error(`Voice transcription failed: ${messageText}`);
      await this.safeSendMessage(`Failed to transcribe voice note: ${messageText}`);
    }
  }

  async handleAttachmentMessage(message) {
    const fileId = String(message.fileId || '').trim();
    if (!fileId) {
      return;
    }

    const durationText = Number.isFinite(message.durationSec) ? ` (${message.durationSec}s)` : '';
    this.logCliEvent(`Telegram -> ${message.type || 'Attachment'}`, `received${durationText}`);

    if (this.isAudioAttachment(message.type)) {
      await this.handleVoiceAttachmentMessage(message, fileId);
      return;
    }

    await this.safeSendMessage('Attachment received.');

    try {
      const downloadedPath = await this.telegram.downloadFile(fileId, ATTACHMENT_DOWNLOAD_DIR);
      const prompt = this.buildAttachmentPrompt(message, downloadedPath);
      await this.enqueueTelegramPrompt(prompt);
    } catch (error) {
      const messageText = error?.message ? String(error.message) : String(error);
      this.logger.error(`Attachment handling failed: ${messageText}`);
      await this.safeSendMessage(`Failed to handle attachment: ${messageText}`);
    }
  }

  async handleCommand(text) {
    const parts = String(text || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const command = normalizeCommandName(parts[0]);
    const argument = parts.slice(1).join(' ').trim();

    if (command === '/help') {
      await this.safeSendMessage(
        [
          'HeyAgent commands:',
          '/help - show command list',
          '/new - start a fresh session',
          '/stop - stop current execution and clear queued messages',
          '/claude - switch to Claude provider',
          '/codex - switch to Codex provider',
          '/grok - switch to Grok provider',
          '/projects - choose a project, then continue or start a session',
          '/sessions or /sessies - choose one of the 10 most recent sessions',
          'ga naar project <naam> - numbered session picker for voice/CarPlay',
          '/status - show current status',
          '',
          `Send any normal message to talk to ${this.provider}.`,
          VOICE_NOTE_HINT_TEXT,
        ].join('\n')
      );
      return;
    }

    if (command === '/new') {
      this.resetSessionMode();
      await this.safeSendMessage('Session reset. Your next message starts fresh.');
      return;
    }

    if (command === '/claude') {
      await this.handleProviderSwitchCommand('claude', argument, 'telegram');
      return;
    }

    if (command === '/codex') {
      await this.handleProviderSwitchCommand('codex', argument, 'telegram');
      return;
    }

    if (command === '/grok') {
      await this.handleProviderSwitchCommand('grok', argument, 'telegram');
      return;
    }

    if (command === '/sessions' || command === '/sessies') {
      await this.showSessionPicker();
      return;
    }

    if (command === '/projects' || command === '/projecten') {
      await this.showProjectPicker();
      return;
    }

    if (command === '/status') {
      await this.safeSendMessage(
        buildStatusText(
          this.config,
          this.provider,
          this.providerArgs,
          this.sleepInhibitorState,
          this.selectedSessionCwd,
          this.voiceTranscriberState
        )
      );
      return;
    }

    if (command === '/stop') {
      const hadVoicePicker = Boolean(this.voiceSessionPickerState);
      this.clearVoiceSessionPickerState();
      const stopped = this.requestStopCurrentPrompt('manual_stop');
      const clearedCount = this.clearQueuedTelegramMessages();

      if (hadVoicePicker) {
        await this.safeSendMessage('Sessiekeuze geannuleerd.');
        return;
      }

      if (stopped) {
        await this.safeSendMessage(`Stopping current ${formatProviderName(this.provider)} request and clearing queued messages...`);
      } else if (clearedCount > 0) {
        await this.safeSendMessage(`Cleared ${clearedCount} queued message${clearedCount === 1 ? '' : 's'}.`);
      } else {
        await this.safeSendMessage('No active request to stop.');
      }
      return;
    }

    await this.safeSendMessage('Unknown command. Use /help.');
  }

  async runProvider(prompt, resume, options = {}) {
    const abortSignal = options.abortSignal || null;
    const cwd = this.selectedSessionCwd || process.cwd();

    if (this.provider === 'claude') {
      return runClaudePrompt(prompt, {
        resume,
        extraArgs: this.providerArgs,
        cwd,
        abortSignal,
        sessionId: this.config.claudeLastSessionId,
        onSessionId: sessionId => {
          this.setBoundSessionId(sessionId);
        },
      });
    }

    if (this.provider === 'codex') {
      return runCodexPrompt(prompt, {
        resume,
        extraArgs: this.providerArgs,
        cwd,
        abortSignal,
        sessionId: this.config.codexLastSessionId,
        onSessionId: sessionId => {
          this.setBoundSessionId(sessionId);
        },
      });
    }

    if (this.provider === 'grok') {
      return runGrokPrompt(prompt, {
        resume,
        extraArgs: this.providerArgs,
        cwd,
        abortSignal,
        sessionId: this.config.grokLastSessionId,
        onSessionId: sessionId => {
          this.setBoundSessionId(sessionId);
        },
      });
    }

    throw new Error(`Unsupported provider: ${this.provider}`);
  }

  async safeSendMessage(text, options = {}) {
    const chatId = this.config.telegramChatId;
    const from = String(options.from || 'HeyAgent').trim() || 'HeyAgent';

    if (!chatId) {
      return;
    }

    this.logCliEvent(`${from} -> Telegram`, text);

    try {
      await this.telegram.sendMessage(chatId, text, options);
    } catch (error) {
      this.logger.error(`Outbox send failed: ${error.message}`);

      if (error instanceof TelegramApiError && error.status === 401) {
        this.config.clearPairing({ keepBotToken: false });
        this.running = false;
        console.error('Telegram bot token is invalid. Restart and enter a new token.');
      }
    }
  }
}

export {
  createProjectSessionKeyboard,
  createSessionKeyboard,
  createSessionProjectKeyboard,
  createTelegramBotCommands,
  formatSessionButtonLabel,
  groupSessionsByProject,
};
export default Bridge;
