const VOICE_SESSION_LIST_LIMIT = 10;

const PROJECT_NAVIGATION_PATTERNS = [/^(?:ga\s+naar|go\s+to|open|switch\s+naar|naar)\s+project\s+(.+)$/i, /^project\s+(.+)$/i];

const VOICE_CANCEL_PATTERNS = [/^(?:annuleer|cancel|stop)$/i, /^\/stop$/i, /^\/cancel$/i];

function normalizeVoiceText(text) {
  return String(text || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeProjectQuery(text) {
  return normalizeVoiceText(text).toLowerCase();
}

export function parseProjectNavigationIntent(text) {
  const normalized = normalizeVoiceText(text);
  if (!normalized) {
    return null;
  }

  for (const pattern of PROJECT_NAVIGATION_PATTERNS) {
    const match = normalized.match(pattern);
    if (match) {
      const project = normalizeVoiceText(match[1]);
      if (project) {
        return project;
      }
    }
  }

  return null;
}

export function isVoicePickerCancel(text) {
  const normalized = normalizeVoiceText(text);
  return VOICE_CANCEL_PATTERNS.some(pattern => pattern.test(normalized));
}

export function parseSessionChoice(text, maxOptions) {
  const normalized = normalizeVoiceText(text);
  if (!normalized || !Number.isFinite(maxOptions) || maxOptions <= 0) {
    return null;
  }

  const directMatch = normalized.match(/^(\d{1,2})$/);
  if (directMatch) {
    const choice = Number(directMatch[1]);
    return choice >= 1 && choice <= maxOptions ? choice : null;
  }

  const labeledMatch = normalized.match(/^(?:sessie|session|nummer|nr|#)\s*(\d{1,2})$/i);
  if (labeledMatch) {
    const choice = Number(labeledMatch[1]);
    return choice >= 1 && choice <= maxOptions ? choice : null;
  }

  if (/^(?:nieuw|new)$/i.test(normalized)) {
    return 'new';
  }

  return null;
}

function projectMatchScore(projectName, query) {
  const project = normalizeProjectQuery(projectName);
  const needle = normalizeProjectQuery(query);

  if (!project || !needle) {
    return -1;
  }
  if (project === needle) {
    return 100;
  }
  if (project.startsWith(needle)) {
    return 80;
  }
  if (project.includes(needle)) {
    return 60;
  }
  if (needle.includes(project)) {
    return 40;
  }
  return -1;
}

export function findProjectGroup(groups, query) {
  const values = Array.isArray(groups) ? groups : [];
  const matches = values
    .map(group => ({
      group,
      score: projectMatchScore(group?.project, query),
    }))
    .filter(entry => entry.score >= 0)
    .sort((a, b) => b.score - a.score || String(a.group?.project || '').localeCompare(String(b.group?.project || '')));

  if (matches.length === 0) {
    return { group: null, ambiguous: [] };
  }

  const best = matches[0];
  const tied = matches.filter(entry => entry.score === best.score);
  if (tied.length > 1) {
    return { group: null, ambiguous: tied.map(entry => entry.group) };
  }

  return { group: best.group, ambiguous: [] };
}

function formatSessionTitle(session) {
  return String(session?.title || session?.lastUserMessage || session?.id || 'Naamloze sessie')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatVoiceProjectPrompt(project, sessions) {
  const projectName = String(project || 'unknown').trim() || 'unknown';
  const list = (Array.isArray(sessions) ? sessions : []).slice(0, VOICE_SESSION_LIST_LIMIT);

  if (list.length === 0) {
    return `Geen sessies gevonden in ${projectName}. Stuur "nieuw" om een verse sessie te starten, of "annuleer".`;
  }

  const lines = list.map((session, index) => `${index + 1} ${formatSessionTitle(session)}`);
  return [`Deze sessies heb je in ${projectName}:`, ...lines, '', 'Welke sessie wil je? Stuur het nummer, "nieuw", of "annuleer".'].join('\n');
}

export function formatAmbiguousProjectsPrompt(groups) {
  const names = (Array.isArray(groups) ? groups : [])
    .map(group => String(group?.project || '').trim())
    .filter(Boolean)
    .slice(0, 10);

  if (names.length === 0) {
    return 'Meerdere projecten gevonden, maar ik kon de namen niet lezen.';
  }

  return [`Meerdere projecten gevonden: ${names.join(', ')}.`, 'Wees specifieker, bijvoorbeeld: "ga naar project bvgeert".'].join('\n');
}

export function formatUnknownProjectPrompt(query, groups) {
  const suggestions = (Array.isArray(groups) ? groups : [])
    .map(group => String(group?.project || '').trim())
    .filter(Boolean)
    .slice(0, 8);

  if (suggestions.length === 0) {
    return `Geen project gevonden voor "${query}".`;
  }

  return [`Geen project gevonden voor "${query}".`, `Beschikbare projecten: ${suggestions.join(', ')}.`].join('\n');
}

export { VOICE_SESSION_LIST_LIMIT };
