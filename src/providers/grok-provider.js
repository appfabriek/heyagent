import { runProcess } from '../process-runner.js';

function pickValue(candidate) {
  return typeof candidate === 'string' ? candidate.trim() : '';
}

function parseGrokJsonOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) {
    return { text: '', sessionId: '' };
  }

  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.startsWith('{') || !line.endsWith('}')) {
      continue;
    }

    try {
      const parsed = JSON.parse(line);
      return {
        text: pickValue(parsed.text) || pickValue(parsed.result) || pickValue(parsed.output),
        sessionId: pickValue(parsed.sessionId) || pickValue(parsed.session_id),
      };
    } catch {
      // Keep scanning older lines.
    }
  }

  return { text: '', sessionId: '' };
}

export async function runGrokPrompt(prompt, options = {}) {
  const resume = Boolean(options.resume);
  const extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs : [];
  const sessionId = String(options.sessionId || '').trim();
  const onSessionId = typeof options.onSessionId === 'function' ? options.onSessionId : null;
  const cwd = options.cwd || process.cwd();
  const abortSignal = options.abortSignal || null;

  const args = [...extraArgs, '--output-format', 'json'];
  if (resume) {
    if (sessionId) {
      args.push('-r', sessionId);
    } else {
      args.push('-c');
    }
  }
  args.push('-p', prompt);

  const result = await runProcess('grok', args, {
    cwd,
    timeoutMs: 20 * 60 * 1000,
    signal: abortSignal,
  });

  const parsed = parseGrokJsonOutput(result.stdout || '');
  if (parsed.sessionId && onSessionId) {
    onSessionId(parsed.sessionId);
  }

  const stderr = (result.stderr || '').trim();
  if (result.code !== 0 && !parsed.text) {
    throw new Error(stderr || `Grok exited with code ${result.code}`);
  }

  return parsed.text || stderr || 'No response from Grok.';
}