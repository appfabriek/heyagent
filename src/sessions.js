import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_MAX_AGE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDirectory(filePath) {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function findJsonlFiles(dir, maxDepth = 4, depth = 0) {
  if (depth > maxDepth) {
    return [];
  }

  const results = [];
  for (const entry of safeReaddir(dir)) {
    const filePath = join(dir, entry);
    if (isDirectory(filePath)) {
      results.push(...findJsonlFiles(filePath, maxDepth, depth + 1));
    } else if (entry.endsWith('.jsonl')) {
      results.push(filePath);
    }
  }
  return results;
}

function readJsonLines(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const parsed = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      parsed.push(JSON.parse(trimmed));
    } catch {
      // Ignore corrupt JSONL lines. A single bad line should not hide the session list.
    }
  }

  return parsed;
}

function truncate(text, maxLength) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) {
    return null;
  }
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function projectPathFromClaudeKey(projectKey) {
  const parts = String(projectKey || '')
    .split('-')
    .filter(Boolean);
  return parts.length > 0 ? `/${parts.join('/')}` : null;
}

function projectNameFromPath(cwd) {
  if (!cwd) {
    return null;
  }
  return cwd.split('/').filter(Boolean).pop() || null;
}

function simplifyModel(model) {
  const value = typeof model === 'string' ? model : '';
  if (!value) {
    return null;
  }
  if (value.includes('opus')) {
    return 'opus';
  }
  if (value.includes('sonnet')) {
    return 'sonnet';
  }
  if (value.includes('haiku')) {
    return 'haiku';
  }
  return value;
}

function extractClaudeUserTexts(entry) {
  if (entry?.type !== 'user') {
    return [];
  }

  const content = entry.message?.content;
  if (typeof content === 'string' && content.trim()) {
    return [content.trim()];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string' && block.text.trim())
    .map(block => block.text.trim());
}

function extractCodexUserText(entry) {
  if (entry?.type !== 'response_item' || entry.payload?.role !== 'user') {
    return '';
  }

  const content = entry.payload?.content;
  if (!Array.isArray(content)) {
    return '';
  }

  const textBlock = content.find(block => {
    const text = typeof block?.text === 'string' ? block.text.trim() : '';
    return block?.type === 'input_text' && text && !text.startsWith('<');
  });

  return typeof textBlock?.text === 'string' ? textBlock.text.trim() : '';
}

export function parseClaudeSessionFile(filePath, sessionId, projectKey) {
  const entries = readJsonLines(filePath);
  let firstUserText = null;
  let lastUserText = null;
  let lastUserTimestamp = null;
  let model = null;

  for (const entry of entries) {
    if (!model && typeof entry.message?.model === 'string') {
      model = entry.message.model;
    }

    const userTexts = extractClaudeUserTexts(entry);
    for (const text of userTexts) {
      if (!firstUserText) {
        firstUserText = text;
      }
      lastUserText = text;
      lastUserTimestamp = entry.timestamp || lastUserTimestamp;
    }
  }

  if (!lastUserTimestamp) {
    return null;
  }

  const cwd = projectPathFromClaudeKey(projectKey);

  return {
    id: sessionId,
    agentType: 'claude',
    title: truncate(firstUserText, 80),
    lastUserMessage: truncate(lastUserText, 120),
    lastUserMessageAt: lastUserTimestamp,
    project: projectNameFromPath(cwd) || projectKey || null,
    cwd,
    model: simplifyModel(model),
    resumable: true,
  };
}

export function parseCodexSessionFile(filePath) {
  const entries = readJsonLines(filePath);
  let sessionId = null;
  let cwd = null;
  let model = null;
  let firstUserText = null;
  let lastUserText = null;
  let lastUserTimestamp = null;

  for (const entry of entries) {
    if (entry?.type === 'session_meta') {
      sessionId = entry.payload?.id || sessionId;
      cwd = entry.payload?.cwd || cwd;
      model = entry.payload?.model || model;
    }

    const userText = extractCodexUserText(entry);
    if (userText) {
      if (!firstUserText) {
        firstUserText = userText;
      }
      lastUserText = userText;
      lastUserTimestamp = entry.timestamp || lastUserTimestamp;
    }
  }

  if (!sessionId || !lastUserTimestamp) {
    return null;
  }

  return {
    id: sessionId,
    agentType: 'codex',
    title: truncate(firstUserText, 80),
    lastUserMessage: truncate(lastUserText, 120),
    lastUserMessageAt: lastUserTimestamp,
    project: projectNameFromPath(cwd),
    cwd: cwd || null,
    model: model || null,
    resumable: true,
  };
}

function isRecentEnough(filePath, maxAgeDays) {
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
    return true;
  }

  const stat = statSync(filePath);
  return Date.now() - stat.mtimeMs <= maxAgeDays * DAY_MS;
}

async function gatherClaudeSessions(homeDir, maxAgeDays) {
  const projectsDir = join(homeDir, '.claude', 'projects');
  if (!existsSync(projectsDir)) {
    return [];
  }

  const sessions = [];
  for (const projectKey of safeReaddir(projectsDir)) {
    const projectDir = join(projectsDir, projectKey);
    if (!isDirectory(projectDir)) {
      continue;
    }

    const files = safeReaddir(projectDir).filter(file => file.endsWith('.jsonl') && !file.includes('subagent'));
    for (const file of files) {
      try {
        const filePath = join(projectDir, file);
        if (!isRecentEnough(filePath, maxAgeDays)) {
          continue;
        }

        const session = parseClaudeSessionFile(filePath, basename(file, '.jsonl'), projectKey);
        if (session) {
          sessions.push(session);
        }
      } catch {
        // Skip unreadable files.
      }
    }
  }

  return sessions;
}

async function gatherCodexSessions(homeDir, maxAgeDays) {
  const sessionsDir = join(homeDir, '.codex', 'sessions');
  if (!existsSync(sessionsDir)) {
    return [];
  }

  const sessions = [];
  for (const filePath of findJsonlFiles(sessionsDir)) {
    try {
      if (!isRecentEnough(filePath, maxAgeDays)) {
        continue;
      }

      const session = parseCodexSessionFile(filePath);
      if (session) {
        sessions.push(session);
      }
    } catch {
      // Skip unreadable files.
    }
  }

  return sessions;
}

export async function gatherSessions(options = {}) {
  const homeDir = options.homeDir || homedir();
  const maxAgeDays = Number.isFinite(options.maxAgeDays) ? options.maxAgeDays : DEFAULT_MAX_AGE_DAYS;
  const results = await Promise.allSettled([gatherClaudeSessions(homeDir, maxAgeDays), gatherCodexSessions(homeDir, maxAgeDays)]);
  const sessions = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      sessions.push(...result.value);
    }
  }

  sessions.sort((a, b) => new Date(b.lastUserMessageAt || 0).getTime() - new Date(a.lastUserMessageAt || 0).getTime());
  return sessions;
}
