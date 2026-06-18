import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gatherSessions, parseClaudeSessionFile, parseCodexSessionFile, parseGrokSessionDir } from '../src/sessions.js';

async function makeHome() {
  return mkdtemp(path.join(os.tmpdir(), 'heyagent-sessions-'));
}

async function writeJsonl(filePath, entries) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, entries.map(entry => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join('\n'));
}

async function writeJsonFile(filePath, entry) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(entry));
}

test('gatherSessions combines Claude and Codex sessions sorted newest first', async () => {
  const homeDir = await makeHome();
  const claudeFile = path.join(homeDir, '.claude', 'projects', '-Users-geert-code-alpha', 'claude-1.jsonl');
  const codexFile = path.join(homeDir, '.codex', 'sessions', '2026', '05', '29', 'codex-1.jsonl');

  await writeJsonl(claudeFile, [
    {
      type: 'user',
      timestamp: '2026-05-29T08:00:00.000Z',
      message: { content: [{ type: 'text', text: 'start Claude work' }] },
    },
    {
      type: 'assistant',
      message: { model: 'claude-sonnet-4-20250514' },
    },
  ]);
  await writeJsonl(codexFile, [
    {
      type: 'session_meta',
      timestamp: '2026-05-29T09:00:00.000Z',
      payload: {
        id: 'codex-1',
        cwd: '/Users/geert/code/beta',
        timestamp: '2026-05-29T09:00:00.000Z',
      },
    },
    {
      type: 'response_item',
      timestamp: '2026-05-29T10:00:00.000Z',
      payload: {
        role: 'user',
        content: [{ type: 'input_text', text: 'continue Codex work' }],
      },
    },
  ]);

  const sessions = await gatherSessions({ homeDir, maxAgeDays: 3650 });

  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].id, 'codex-1');
  assert.equal(sessions[0].agentType, 'codex');
  assert.equal(sessions[0].project, 'beta');
  assert.equal(sessions[1].id, 'claude-1');
  assert.equal(sessions[1].agentType, 'claude');
  assert.equal(sessions[1].project, 'alpha');
});

test('parseClaudeSessionFile ignores corrupt lines and returns last user message', async () => {
  const homeDir = await makeHome();
  const filePath = path.join(homeDir, 'claude.jsonl');
  await writeJsonl(filePath, [
    '{not-json',
    {
      type: 'user',
      timestamp: '2026-05-29T08:00:00.000Z',
      message: { content: [{ type: 'text', text: 'first question' }] },
    },
    {
      type: 'user',
      timestamp: '2026-05-29T09:00:00.000Z',
      message: { content: [{ type: 'text', text: 'latest question' }] },
    },
  ]);

  const session = parseClaudeSessionFile(filePath, 'claude-session', '-Users-geert-code-myproject');

  assert.equal(session.id, 'claude-session');
  assert.equal(session.title, 'first question');
  assert.equal(session.lastUserMessage, 'latest question');
  assert.equal(session.lastUserMessageAt, '2026-05-29T09:00:00.000Z');
  assert.equal(session.cwd, '/Users/geert/code/myproject');
});

test('gatherSessions uses Codex thread names from session index', async () => {
  const homeDir = await makeHome();
  const codexFile = path.join(homeDir, '.codex', 'sessions', '2026', '05', '29', 'codex-title.jsonl');
  const indexFile = path.join(homeDir, '.codex', 'session_index.jsonl');

  await writeJsonl(codexFile, [
    {
      type: 'session_meta',
      timestamp: '2026-05-29T09:00:00.000Z',
      payload: {
        id: 'codex-title',
        cwd: '/Users/geert/code/heyagent',
      },
    },
    {
      type: 'response_item',
      timestamp: '2026-05-29T10:00:00.000Z',
      payload: {
        role: 'user',
        content: [{ type: 'input_text', text: '# AGENTS.md instructions for /Users/geert/code/heyagent' }],
      },
    },
  ]);
  await writeJsonl(indexFile, [
    {
      id: 'codex-title',
      thread_name: 'Voeg sessiekeuze toe',
      updated_at: '2026-05-29T10:00:00.000Z',
    },
  ]);

  const sessions = await gatherSessions({ homeDir, maxAgeDays: 3650 });

  assert.equal(sessions[0].id, 'codex-title');
  assert.equal(sessions[0].title, 'Voeg sessiekeuze toe');
});

test('gatherSessions uses Claude Desktop local session titles', async () => {
  const homeDir = await makeHome();
  const claudeFile = path.join(homeDir, '.claude', 'projects', '-Users-geert-code-bvgeert', 'claude-title.jsonl');
  const localSessionFile = path.join(
    homeDir,
    'Library',
    'Application Support',
    'Claude',
    'claude-code-sessions',
    'workspace',
    'project',
    'local-session.json'
  );

  await writeJsonl(claudeFile, [
    {
      type: 'user',
      timestamp: '2026-05-29T08:00:00.000Z',
      message: { content: 'pull' },
    },
  ]);
  await mkdir(path.dirname(localSessionFile), { recursive: true });
  await writeFile(
    localSessionFile,
    JSON.stringify({
      sessionId: 'local-1',
      cliSessionId: 'claude-title',
      title: 'Telegram plugin installation',
    })
  );

  const sessions = await gatherSessions({ homeDir, maxAgeDays: 3650 });

  assert.equal(sessions[0].id, 'claude-title');
  assert.equal(sessions[0].title, 'Telegram plugin installation');
});

test('gatherSessions skips Claude sessions marked archived in Claude Desktop metadata', async () => {
  const homeDir = await makeHome();
  const activeClaudeFile = path.join(homeDir, '.claude', 'projects', '-Users-geert-code-bvgeert', 'claude-active.jsonl');
  const archivedClaudeFile = path.join(homeDir, '.claude', 'projects', '-Users-geert-code-bvgeert', 'claude-archived.jsonl');
  const activeMetadataFile = path.join(
    homeDir,
    'Library',
    'Application Support',
    'Claude',
    'claude-code-sessions',
    'workspace',
    'project',
    'active.json'
  );
  const archivedMetadataFile = path.join(
    homeDir,
    'Library',
    'Application Support',
    'Claude',
    'claude-code-sessions',
    'workspace',
    'project',
    'archived.json'
  );

  await writeJsonl(activeClaudeFile, [
    {
      type: 'user',
      timestamp: '2026-05-29T08:00:00.000Z',
      message: { content: 'active session prompt' },
    },
  ]);
  await writeJsonl(archivedClaudeFile, [
    {
      type: 'user',
      timestamp: '2026-05-29T09:00:00.000Z',
      message: { content: 'archived session prompt' },
    },
  ]);
  await mkdir(path.dirname(activeMetadataFile), { recursive: true });
  await writeFile(
    activeMetadataFile,
    JSON.stringify({
      cliSessionId: 'claude-active',
      title: 'Active Claude session',
      isArchived: false,
    })
  );
  await writeFile(
    archivedMetadataFile,
    JSON.stringify({
      cliSessionId: 'claude-archived',
      title: 'Archived Claude session',
      isArchived: true,
    })
  );

  const sessions = await gatherSessions({ homeDir, maxAgeDays: 3650 });

  assert.deepEqual(
    sessions.map(session => session.id),
    ['claude-active']
  );
  assert.equal(sessions[0].title, 'Active Claude session');
});

test('parseCodexSessionFile skips sessions without a user message', async () => {
  const homeDir = await makeHome();
  const filePath = path.join(homeDir, 'codex.jsonl');
  await writeJsonl(filePath, [
    {
      type: 'session_meta',
      timestamp: '2026-05-29T09:00:00.000Z',
      payload: { id: 'codex-empty', cwd: '/Users/geert/code/empty' },
    },
  ]);

  assert.equal(parseCodexSessionFile(filePath), null);
});

test('parseGrokSessionDir reads summary and user query from chat history', async () => {
  const homeDir = await makeHome();
  const cwdKey = encodeURIComponent('/Users/geert/code/heyagent');
  const sessionDir = path.join(homeDir, '.grok', 'sessions', cwdKey, 'grok-session-1');

  await writeJsonFile(path.join(sessionDir, 'summary.json'), {
    info: {
      id: 'grok-session-1',
      cwd: '/Users/geert/code/heyagent',
    },
    session_summary: 'Explaining What This Project Does',
    generated_title: 'Explaining What This Project Does',
    created_at: '2026-06-18T12:30:25.678554Z',
    updated_at: '2026-06-18T12:35:18.095173Z',
    last_active_at: '2026-06-18T12:35:18.095172Z',
    current_model_id: 'grok-composer-2.5-fast',
  });
  await writeJsonl(path.join(sessionDir, 'chat_history.jsonl'), [
    {
      type: 'user',
      content: [{ type: 'text', text: '<user_query>\nwat doet dit project?\n</user_query>' }],
    },
    {
      type: 'user',
      content: [{ type: 'text', text: '<user_query>\nvoeg grok toe\n</user_query>' }],
    },
  ]);

  const session = parseGrokSessionDir(sessionDir, cwdKey);

  assert.equal(session.id, 'grok-session-1');
  assert.equal(session.agentType, 'grok');
  assert.equal(session.title, 'Explaining What This Project Does');
  assert.equal(session.lastUserMessage, 'voeg grok toe');
  assert.equal(session.project, 'heyagent');
  assert.equal(session.cwd, '/Users/geert/code/heyagent');
});

test('gatherSessions includes Grok sessions sorted with other providers', async () => {
  const homeDir = await makeHome();
  const cwdKey = encodeURIComponent('/Users/geert/code/heyagent');
  const grokDir = path.join(homeDir, '.grok', 'sessions', cwdKey, 'grok-newest');
  const codexFile = path.join(homeDir, '.codex', 'sessions', '2026', '06', '18', 'codex-older.jsonl');

  await writeJsonFile(path.join(grokDir, 'summary.json'), {
    info: { id: 'grok-newest', cwd: '/Users/geert/code/heyagent' },
    session_summary: 'Grok newest session',
    last_active_at: '2026-06-18T13:00:00.000Z',
  });
  await writeJsonl(path.join(grokDir, 'chat_history.jsonl'), [
    {
      type: 'user',
      content: [{ type: 'text', text: '<user_query>\nlatest grok prompt\n</user_query>' }],
    },
  ]);
  await writeJsonl(codexFile, [
    {
      type: 'session_meta',
      timestamp: '2026-06-18T12:00:00.000Z',
      payload: { id: 'codex-older', cwd: '/Users/geert/code/heyagent' },
    },
    {
      type: 'response_item',
      timestamp: '2026-06-18T12:30:00.000Z',
      payload: {
        role: 'user',
        content: [{ type: 'input_text', text: 'older codex prompt' }],
      },
    },
  ]);

  const sessions = await gatherSessions({ homeDir, maxAgeDays: 3650 });

  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].id, 'grok-newest');
  assert.equal(sessions[0].agentType, 'grok');
  assert.equal(sessions[1].id, 'codex-older');
});

test('gatherSessions skips files older than maxAgeDays', async () => {
  const homeDir = await makeHome();
  const oldFile = path.join(homeDir, '.codex', 'sessions', '2026', '05', '29', 'old.jsonl');
  await writeJsonl(oldFile, [
    {
      type: 'session_meta',
      timestamp: '2026-05-29T09:00:00.000Z',
      payload: { id: 'old-session', cwd: '/Users/geert/code/old' },
    },
    {
      type: 'response_item',
      timestamp: '2026-05-29T10:00:00.000Z',
      payload: { role: 'user', content: [{ type: 'input_text', text: 'old prompt' }] },
    },
  ]);
  await utimes(oldFile, new Date('2020-01-01T00:00:00.000Z'), new Date('2020-01-01T00:00:00.000Z'));

  const sessions = await gatherSessions({ homeDir, maxAgeDays: 1 });

  assert.deepEqual(sessions, []);
});
