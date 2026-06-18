import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findProjectGroup,
  formatVoiceProjectPrompt,
  isVoicePickerCancel,
  parseProjectNavigationIntent,
  parseSessionChoice,
} from '../src/voice-session-picker.js';

function makeGroup(project, sessions = []) {
  return {
    project,
    cwd: `/Users/geert/code/${project}`,
    sessions,
  };
}

function makeSession(title, overrides = {}) {
  return {
    id: 'session-1',
    agentType: 'grok',
    title,
    project: 'bvgeert',
    cwd: '/Users/geert/code/bvgeert',
    resumable: true,
    ...overrides,
  };
}

test('parseProjectNavigationIntent recognizes Dutch and English project commands', () => {
  assert.equal(parseProjectNavigationIntent('Ga naar project bvgeert'), 'bvgeert');
  assert.equal(parseProjectNavigationIntent('go to project heyagent'), 'heyagent');
  assert.equal(parseProjectNavigationIntent('project bvgeert'), 'bvgeert');
  assert.equal(parseProjectNavigationIntent('hallo'), null);
});

test('parseSessionChoice accepts numbers and new', () => {
  assert.equal(parseSessionChoice('2', 3), 2);
  assert.equal(parseSessionChoice('sessie 2', 3), 2);
  assert.equal(parseSessionChoice('#2', 3), 2);
  assert.equal(parseSessionChoice('nieuw', 3), 'new');
  assert.equal(parseSessionChoice('9', 3), null);
});

test('findProjectGroup resolves exact and partial project names', () => {
  const groups = [makeGroup('heyagent'), makeGroup('bvgeert')];
  assert.equal(findProjectGroup(groups, 'bvgeert').group?.project, 'bvgeert');
  assert.equal(findProjectGroup(groups, 'bvg').group?.project, 'bvgeert');
});

test('formatVoiceProjectPrompt renders numbered session list', () => {
  const prompt = formatVoiceProjectPrompt('bvgeert', [makeSession('jobs aanpakken'), makeSession('ui refresh')]);
  assert.match(prompt, /Deze sessies heb je in bvgeert:/);
  assert.match(prompt, /1 jobs aanpakken/);
  assert.match(prompt, /2 ui refresh/);
  assert.match(prompt, /Welke sessie wil je\?/);
});

test('isVoicePickerCancel recognizes cancel phrases', () => {
  assert.equal(isVoicePickerCancel('annuleer'), true);
  assert.equal(isVoicePickerCancel('/stop'), true);
  assert.equal(isVoicePickerCancel('2'), false);
});