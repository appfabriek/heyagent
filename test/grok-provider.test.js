import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGrokJsonObject, parseGrokJsonOutput } from '../src/providers/grok-provider.js';

test('parseGrokJsonOutput reads pretty-printed Grok JSON', () => {
  const stdout = `{
  "text": "Hello",
  "stopReason": "EndTurn",
  "sessionId": "019edb10-9afe-7622-99ca-4fca7f78ebfb"
}`;

  assert.deepEqual(parseGrokJsonOutput(stdout), {
    text: 'Hello',
    sessionId: '019edb10-9afe-7622-99ca-4fca7f78ebfb',
  });
});

test('parseGrokJsonOutput reads single-line NDJSON', () => {
  const stdout = '{"text":"Hi there","session_id":"abc-123"}';

  assert.deepEqual(parseGrokJsonOutput(stdout), {
    text: 'Hi there',
    sessionId: 'abc-123',
  });
});

test('parseGrokJsonObject returns null for empty output', () => {
  assert.equal(parseGrokJsonObject(''), null);
  assert.equal(parseGrokJsonObject('   \n  '), null);
});